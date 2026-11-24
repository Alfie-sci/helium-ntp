// Standalone WebGL2 Gradient Shimmer implementation based on @imput/helium-prism
(function () {
  const STRIPE_WIDTH = { min: 64, target: 110, max: 120 };
  const GRADIENT = { bandWidth: 0.48, minStop: 0.14, maxStop: 0.96 };
  const INTRO = {
    delay: 700,
    revealDuration: 840,
    idleBlendDuration: 500,
    stagger: 45,
    startCenter: 0.96,
    idleCenter: 0.5,
  };
  const IDLE_WAVE = {
    speed: 0.42,
    stripePhase: 0.74,
    secondarySpeed: 0.26,
    secondaryStripePhase: 1.28,
    primaryAmplitude: 0.19,
    secondaryAmplitude: 0.055,
  };
  const FULL_CIRCLE = Math.PI * 2;
  const GRAIN = {
    size: 180,
    hashScale: [127.1, 311.7],
    hashOffset: 43758.5,
    channelOffsets: [[0, 0], [17, 3], [7, 29], [31, 11]],
  };

  function createGrainNoise() {
    const { size, hashScale, hashOffset, channelOffsets } = GRAIN;
    const data = new Uint8Array(size * size * channelOffsets.length);
    let index = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        for (let i = 0; i < channelOffsets.length; i++) {
          const [offsetX, offsetY] = channelOffsets[i];
          const hash = Math.sin((x + offsetX) * hashScale[0] + (y + offsetY) * hashScale[1]) * hashOffset;
          data[index++] = Math.round((hash - Math.floor(hash)) * 255);
        }
      }
    }
    return data;
  }

  function clamp(val, min = 0, max = 1) {
    return Math.max(min, Math.min(max, val));
  }

  function getStripeCount(canvasWidth) {
    const minCount = Math.max(1, Math.ceil(canvasWidth / STRIPE_WIDTH.max));
    const maxCount = Math.max(1, Math.floor(canvasWidth / STRIPE_WIDTH.min));
    const targetCount = Math.max(1, Math.round(canvasWidth / STRIPE_WIDTH.target));
    return Math.max(minCount, Math.min(maxCount, targetCount));
  }

  function getStripeMetrics(width) {
    const count = getStripeCount(width);
    const stripeWidth = width / count;
    const maxIndex = count - 1;
    return {
      count,
      width: stripeWidth,
      maxIndex,
      introCenterIndex: maxIndex / 2,
      introCenterDistance: count % 2 === 0 ? 0.5 : 0,
    };
  }

  function getRenderMetrics(size, stripes) {
    const gradientVerticalSpan = size.height * 1.7;
    return {
      inverseDpr: 1 / size.dpr,
      gradientTop: size.height * -0.35,
      gradientVerticalSpan,
      inverseGradientDenominator: 1 / (stripes.width * stripes.width + gradientVerticalSpan * gradientVerticalSpan),
    };
  }

  function parseColorChannel(channel) {
    if (channel.endsWith('%')) {
      return clamp(parseFloat(channel) / 100);
    }
    return clamp(parseFloat(channel) / 255);
  }

  function parseCssColorValue(value) {
    const color = value.trim().toLowerCase();
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex.split('').map(p => p + p).join('');
      }
      if (hex.length === 6) {
        return [
          parseInt(hex.slice(0, 2), 16) / 255,
          parseInt(hex.slice(2, 4), 16) / 255,
          parseInt(hex.slice(4, 6), 16) / 255,
        ];
      }
    }
    const channels = color.match(/-?\d*\.?\d+(?:e[+-]?\d+)?%?/g) || [];
    if (channels.length >= 3) {
      return [
        parseColorChannel(channels[0]),
        parseColorChannel(channels[1]),
        parseColorChannel(channels[2]),
      ];
    }
    return [0, 0, 0];
  }

  function readCssColor(styles, name, ctx) {
    const rawValue = styles.getPropertyValue(name).trim();
    if (!rawValue) return [0, 0, 0];
    ctx.fillStyle = '#000000';
    ctx.fillStyle = rawValue;
    return parseCssColorValue(ctx.fillStyle);
  }

  function readCssNumber(styles, name, fallback = 0) {
    const rawValue = styles.getPropertyValue(name).trim();
    const val = Number(rawValue);
    return !rawValue || !Number.isFinite(val) ? fallback : val;
  }

  function compileShader(gl, type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;

in vec2 position;

uniform vec2 u_size;
uniform float u_stripe_max_index;
uniform float u_stripe_width;
uniform float u_wave_phase;
uniform float u_secondary_wave_phase;
uniform float u_intro_active;
uniform float u_intro_elapsed;
uniform float u_shine_progress;

uniform float u_alpha;
uniform float u_intro_alpha;
uniform float u_speed_up_shine_boost;

uniform float u_gradient_band_width;
uniform float u_gradient_min_stop;
uniform float u_gradient_max_stop;
uniform float u_intro_reveal_duration;
uniform float u_intro_reveal_duration_inverse;
uniform float u_intro_idle_blend_duration_inverse;
uniform float u_intro_stagger;
uniform float u_intro_center_index;
uniform float u_intro_center_distance;
uniform float u_intro_start_center;
uniform float u_intro_idle_center;
uniform float u_idle_stripe_phase;
uniform float u_idle_secondary_stripe_phase;
uniform float u_idle_primary_amplitude;
uniform float u_idle_secondary_amplitude;

flat out float v_stripe_start;
flat out vec3 v_band;
flat out vec3 v_band_inverse;
flat out float v_out_alpha;
flat out float v_highlight_strength;

const float EPSILON = 0.0001;

float clamp01(float value) {
    return clamp(value, 0.0, 1.0);
}

float easeOutCubic(float value) {
    float inverse = 1.0 - value;
    return 1.0 - inverse * inverse * inverse;
}

float introRevealProgress(float delayed_elapsed) {
    if (u_intro_active < 0.5) {
        return 1.0;
    }
    return easeOutCubic(
        clamp01(delayed_elapsed * u_intro_reveal_duration_inverse)
    );
}

float introIdleProgress(float delayed_elapsed) {
    if (u_intro_active < 0.5) {
        return 1.0;
    }
    return easeOutCubic(
        clamp01(
            (delayed_elapsed - u_intro_reveal_duration) *
                u_intro_idle_blend_duration_inverse
        )
    );
}

void main() {
    float stripe_index = float(gl_InstanceID);
    float stripe_start = stripe_index * u_stripe_width;
    float edge_x = (stripe_index + position.x) * u_stripe_width;

    if (stripe_index == u_stripe_max_index && position.x > 0.5) {
        edge_x = u_size.x;
    }

    gl_Position = vec4(edge_x / u_size.x * 2.0 - 1.0, position.y, 0.0, 1.0);

    float reveal_delay = max(
        0.0,
        abs(stripe_index - u_intro_center_index) - u_intro_center_distance
    ) * u_intro_stagger;
    float delayed_intro_elapsed = u_intro_elapsed - reveal_delay;
    float reveal_progress = introRevealProgress(delayed_intro_elapsed);
    float idle_progress = introIdleProgress(delayed_intro_elapsed);
    float alpha = u_intro_alpha + (u_alpha - u_intro_alpha) * idle_progress;
    float stripe_phase = stripe_index * u_idle_stripe_phase;
    float secondary_stripe_phase = stripe_index * u_idle_secondary_stripe_phase;
    float primary_wave = sin(u_wave_phase - stripe_phase);
    float secondary_wave = sin(
        u_secondary_wave_phase + secondary_stripe_phase
    );
    float idle_center = 0.5 +
        primary_wave * u_idle_primary_amplitude +
        secondary_wave * u_idle_secondary_amplitude;
    float intro_center = mix(
        u_intro_start_center,
        u_intro_idle_center,
        reveal_progress
    );
    float center = mix(intro_center, idle_center, idle_progress);
    float band_start = clamp(
        center - u_gradient_band_width,
        u_gradient_min_stop,
        u_gradient_max_stop
    );
    float band_end = clamp(
        center + u_gradient_band_width,
        u_gradient_min_stop,
        u_gradient_max_stop
    );
    float gradient_alpha = clamp01(
        alpha * (1.0 + u_shine_progress * u_speed_up_shine_boost)
    ) * reveal_progress;
    float out_alpha = gradient_alpha + alpha * (1.0 - gradient_alpha);

    v_stripe_start = stripe_start;
    v_band = vec3(band_start, center, band_end);
    v_band_inverse = 1.0 / max(
        vec3(band_start, center - band_start, band_end - center),
        EPSILON
    );
    v_out_alpha = out_alpha;
    v_highlight_strength = gradient_alpha / max(out_alpha, EPSILON);
}`;
  const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

uniform vec2 u_size;
uniform float u_inverse_dpr;
uniform float u_stripe_width;
uniform float u_gradient_top;
uniform float u_gradient_vertical_span;
uniform float u_inverse_gradient_denominator;

uniform vec3 u_start_color;
uniform vec3 u_highlight_delta;
uniform float u_grain_alpha;
uniform float u_grain_luminance;
uniform float u_grain_contrast;
uniform float u_grain_saturation;
uniform sampler2D u_grain_noise;

flat in float v_stripe_start;
flat in vec3 v_band;
flat in vec3 v_band_inverse;
flat in float v_out_alpha;
flat in float v_highlight_strength;

const float GRAIN_SIZE = 180.0;

out vec4 fragment_color;

float clamp01(float value) {
    return clamp(value, 0.0, 1.0);
}

vec3 overlayBlend(vec3 base, vec3 blend) {
    vec3 low = 2.0 * base * blend;
    vec3 high = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
    return mix(low, high, step(vec3(0.5), base));
}

float gradientHighlightAmount(float position) {
    if (position < v_band.x) {
        return 1.0 - clamp01(position * v_band_inverse.x);
    }
    if (position < v_band.y) {
        return clamp01((position - v_band.x) * v_band_inverse.y);
    }
    if (position < v_band.z) {
        return 1.0 - clamp01((position - v_band.y) * v_band_inverse.z);
    }
    return 0.0;
}

void main() {
    vec2 css_position = vec2(
        gl_FragCoord.x * u_inverse_dpr,
        u_size.y - gl_FragCoord.y * u_inverse_dpr
    );
    vec2 gradient_offset = vec2(
        css_position.x - v_stripe_start,
        css_position.y - u_gradient_top
    );
    vec2 gradient_axis = vec2(
        u_stripe_width,
        u_gradient_vertical_span
    );
    float gradient_position = clamp01(
        dot(gradient_offset, gradient_axis) * u_inverse_gradient_denominator
    );
    vec3 color = u_start_color + u_highlight_delta * (
        gradientHighlightAmount(gradient_position) * v_highlight_strength
    );

    ivec2 grain_position = min(
        ivec2(mod(css_position, GRAIN_SIZE)),
        ivec2(GRAIN_SIZE - 1.0)
    );
    vec4 noise = texelFetch(u_grain_noise, grain_position, 0) - 0.5;
    float luminance = u_grain_luminance + noise.r * u_grain_contrast;
    vec3 color_shift = noise.gba * u_grain_saturation;
    vec3 grain = clamp((vec3(luminance) + color_shift) / 255.0, 0.0, 1.0);

    color = mix(color, overlayBlend(color, grain), u_grain_alpha);
    fragment_color = vec4(color * v_out_alpha, v_out_alpha);
}`;

  function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return null;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return null;
    }

    // Vertex data: quad (0, -1) to (1, 1)
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0, -1,
        1, -1,
        0,  1,
        0,  1,
        1, -1,
        1,  1,
      ]),
      gl.STATIC_DRAW
    );

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const posLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Grain texture
    const grainTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, grainTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      GRAIN.size,
      GRAIN.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      createGrainNoise()
    );

    // Uniform locations
    const u = {};
    const uniformNames = [
      'u_size', 'u_inverse_dpr', 'u_stripe_max_index', 'u_stripe_width',
      'u_gradient_top', 'u_gradient_vertical_span', 'u_inverse_gradient_denominator',
      'u_wave_phase', 'u_secondary_wave_phase', 'u_intro_active', 'u_intro_elapsed',
      'u_shine_progress', 'u_start_color', 'u_highlight_delta', 'u_alpha',
      'u_intro_alpha', 'u_speed_up_shine_boost', 'u_grain_alpha', 'u_grain_luminance',
      'u_grain_contrast', 'u_grain_saturation', 'u_grain_noise',
      'u_intro_center_index', 'u_intro_center_distance', 'u_gradient_band_width',
      'u_gradient_min_stop', 'u_gradient_max_stop', 'u_intro_reveal_duration',
      'u_intro_reveal_duration_inverse', 'u_intro_idle_blend_duration_inverse',
      'u_intro_stagger', 'u_intro_start_center', 'u_intro_idle_center',
      'u_idle_stripe_phase', 'u_idle_secondary_stripe_phase',
      'u_idle_primary_amplitude', 'u_idle_secondary_amplitude'
    ];
    for (const name of uniformNames) {
      u[name] = gl.getUniformLocation(program, name);
    }

    gl.useProgram(program);
    gl.uniform1i(u.u_grain_noise, 0);
    gl.uniform1f(u.u_gradient_band_width, GRADIENT.bandWidth);
    gl.uniform1f(u.u_gradient_min_stop, GRADIENT.minStop);
    gl.uniform1f(u.u_gradient_max_stop, GRADIENT.maxStop);
    gl.uniform1f(u.u_intro_reveal_duration, INTRO.revealDuration);
    gl.uniform1f(u.u_intro_reveal_duration_inverse, 1 / INTRO.revealDuration);
    gl.uniform1f(u.u_intro_idle_blend_duration_inverse, 1 / INTRO.idleBlendDuration);
    gl.uniform1f(u.u_intro_stagger, INTRO.stagger);
    gl.uniform1f(u.u_intro_start_center, INTRO.startCenter);
    gl.uniform1f(u.u_intro_idle_center, INTRO.idleCenter);
    gl.uniform1f(u.u_idle_stripe_phase, IDLE_WAVE.stripePhase);
    gl.uniform1f(u.u_idle_secondary_stripe_phase, IDLE_WAVE.secondaryStripePhase);
    gl.uniform1f(u.u_idle_primary_amplitude, IDLE_WAVE.primaryAmplitude);
    gl.uniform1f(u.u_idle_secondary_amplitude, IDLE_WAVE.secondaryAmplitude);

    const colorCanvas = document.createElement('canvas');
    const colorCtx = colorCanvas.getContext('2d');

    let stripeCount = 1;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, rect.width || window.innerWidth);
      const height = Math.max(1, rect.height || window.innerHeight);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);

      const size = { width, height, dpr };
      const stripes = getStripeMetrics(width);
      stripeCount = stripes.count;
      const renderMetrics = getRenderMetrics(size, stripes);

      gl.useProgram(program);
      gl.uniform2f(u.u_size, width, height);
      gl.uniform1f(u.u_inverse_dpr, renderMetrics.inverseDpr);
      gl.uniform1f(u.u_stripe_max_index, stripes.maxIndex);
      gl.uniform1f(u.u_stripe_width, stripes.width);
      gl.uniform1f(u.u_gradient_top, renderMetrics.gradientTop);
      gl.uniform1f(u.u_gradient_vertical_span, renderMetrics.gradientVerticalSpan);
      gl.uniform1f(u.u_inverse_gradient_denominator, renderMetrics.inverseGradientDenominator);
      gl.uniform1f(u.u_intro_center_index, stripes.introCenterIndex);
      gl.uniform1f(u.u_intro_center_distance, stripes.introCenterDistance);
    }

    function readColors() {
      const styles = getComputedStyle(canvas);
      const start = readCssColor(styles, '--shimmer-start', colorCtx);
      const highlight = readCssColor(styles, '--shimmer-highlight', colorCtx);

      gl.useProgram(program);
      gl.uniform3f(u.u_start_color, start[0], start[1], start[2]);
      gl.uniform3f(u.u_highlight_delta, highlight[0] - start[0], highlight[1] - start[1], highlight[2] - start[2]);
      gl.uniform1f(u.u_alpha, readCssNumber(styles, '--shimmer-alpha', 0.7));
      gl.uniform1f(u.u_intro_alpha, readCssNumber(styles, '--shimmer-intro-alpha', 1.0));
      gl.uniform1f(u.u_speed_up_shine_boost, readCssNumber(styles, '--shimmer-speed-up-shine-boost', 0.15));
      gl.uniform1f(u.u_grain_alpha, readCssNumber(styles, '--shimmer-grain-alpha', 0.15));
      gl.uniform1f(u.u_grain_luminance, readCssNumber(styles, '--shimmer-grain-luminance', 144));
      gl.uniform1f(u.u_grain_contrast, readCssNumber(styles, '--shimmer-grain-contrast', 64));
      gl.uniform1f(u.u_grain_saturation, readCssNumber(styles, '--shimmer-grain-saturation', 32));
    }

    return {
      resize,
      readColors,
      render({ time, wavePhase, secondaryWavePhase, introStartedAt, shineProgress }) {
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.uniform1f(u.u_wave_phase, wavePhase);
        gl.uniform1f(u.u_secondary_wave_phase, secondaryWavePhase);
        gl.uniform1f(u.u_intro_active, introStartedAt === null ? 0 : 1);
        gl.uniform1f(u.u_intro_elapsed, introStartedAt === null ? 0 : time - introStartedAt - INTRO.delay);
        gl.uniform1f(u.u_shine_progress, shineProgress);

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, stripeCount);
      },
      getStripeCount() {
        return stripeCount;
      },
      dispose() {
        gl.deleteBuffer(posBuffer);
        gl.deleteVertexArray(vao);
        gl.deleteTexture(grainTex);
        gl.deleteProgram(program);
      }
    };
  }

  function initShimmer() {
    const canvas = document.getElementById('gradient-shimmer');
    if (!canvas) return;

    const renderer = createRenderer(canvas);
    if (!renderer) {
      canvas.classList.add('fallback');
      canvas.classList.add('visible');
      return;
    }

    let introStartedAt = performance.now();
    let wavePhase = Math.random() * FULL_CIRCLE;
    let secondaryWavePhase = -wavePhase * 0.7;
    let lastFrameTime = null;

    renderer.resize();
    renderer.readColors();

    function onResize() {
      renderer.resize();
      renderer.readColors();
    }
    window.addEventListener('resize', onResize);

    function frame(time) {
      const deltaSeconds = lastFrameTime === null ? 0 : Math.min((time - lastFrameTime) / 1000, 0.064);
      lastFrameTime = time;

      wavePhase += IDLE_WAVE.speed * deltaSeconds;
      secondaryWavePhase += IDLE_WAVE.secondarySpeed * deltaSeconds;

      renderer.render({
        time,
        wavePhase,
        secondaryWavePhase,
        introStartedAt,
        shineProgress: 0,
      });

      requestAnimationFrame(frame);
    }

    // Paint first frame then show
    frame(performance.now());
    requestAnimationFrame(() => {
      canvas.classList.add('visible');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShimmer);
  } else {
    initShimmer();
  }
})();
