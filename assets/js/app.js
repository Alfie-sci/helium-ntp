const CONFIG = {
    animation: {
        speedX: 0.0003,
        speedY: 0.0005,
        scale: 1.5,
        pulseDuration: 6 // Seconds for a full 100% -> 80% -> 100% breathing cycle
    }
};

// Clean up any previously cached background data
try {
    localStorage.removeItem('helium_bg');
} catch (e) {}

const init3D = () => {
    const canvas = document.getElementById('app-3d');
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
        precision: 'mediump'
    });

    const baseSize = 64;
    renderer.setSize(baseSize, baseSize, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    canvas.style.width = (baseSize * CONFIG.animation.scale) + 'px';
    canvas.style.height = (baseSize * CONFIG.animation.scale) + 'px';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 10;

    const ditherMaterial = new THREE.ShaderMaterial({
        vertexShader: `
            varying vec3 vNormal;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec3 vNormal;
            void main() {
                vec3 lightDir = normalize(vec3(0.5, 1.0, 1.0));
                float diff = max(dot(vNormal, lightDir), 0.0);
                vec2 pos = floor(gl_FragCoord.xy);
                float dither = mod(pos.x + pos.y, 2.0); 
                float stepDiff = step(0.5, diff + (dither * 0.3 - 0.15));
                vec3 highlightColor = vec3(1.0, 1.0, 1.0);
                vec3 shadowColor = vec3(0.5, 0.6, 0.9); 
                gl_FragColor = vec4(mix(shadowColor, highlightColor, stepDiff), 1.0);
            }
        `
    });

    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.5, 6, 0.5);
    for (let i = 0; i < 4; i++) {
        const mesh = new THREE.Mesh(geo, ditherMaterial);
        mesh.rotation.z = (Math.PI / 4) * i;
        group.add(mesh);
    }
    group.scale.set(0, 0, 0);
    scene.add(group);

    let isPaused = false;
    let startTime = null;

    const animate3D = (time) => {
        if (isPaused) return;
        if (!startTime) startTime = time;

        const elapsed = (time - startTime) / 1000;
        const entranceDuration = 1.2;

        if (elapsed < entranceDuration) {
            const t = elapsed / entranceDuration;
            const scale = 1 + 0.1 * Math.sin(t * Math.PI) * (1 - t);
            const finalScale = t < 1 ? t * scale : 1;
            group.scale.set(finalScale, finalScale, finalScale);
        } else {
            const postElapsed = elapsed - entranceDuration;
            const cycleDuration = CONFIG.animation.pulseDuration || 6;
            const freq = (2 * Math.PI) / cycleDuration;
            // Oscillates smoothly between 100% (1.0) and 80% (0.8)
            const scale = 0.9 + 0.1 * Math.cos(freq * postElapsed);
            group.scale.set(scale, scale, scale);
        }

        requestAnimationFrame(animate3D);
        group.rotation.y = (time * CONFIG.animation.speedY);
        group.rotation.x = (time * CONFIG.animation.speedX);
        renderer.render(scene, camera);
    };
    requestAnimationFrame(animate3D);

    document.addEventListener('visibilitychange', () => {
        const wasPaused = isPaused;
        isPaused = document.hidden;
        if (wasPaused && !isPaused) requestAnimationFrame(animate3D);
    });

    window.addEventListener('resize', () => {
        const dpr = window.devicePixelRatio || 1;
        renderer.setPixelRatio(dpr);
        camera.aspect = 1;
        camera.updateProjectionMatrix();
    });
};

const updateClock = () => {
    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date');
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');

    if (clockEl) {
        clockEl.textContent = '';
        const digits = [h[0], h[1], ':', m[0], m[1]];
        let numIndex = 0;
        digits.forEach(char => {
            if (char === ':') {
                const colon = document.createElement('span');
                colon.className = 'colon';
                colon.textContent = ':';
                clockEl.appendChild(colon);
            } else {
                const span = document.createElement('span');
                span.textContent = char;
                if (numIndex % 2 === 1) {
                    span.className = 'num-alt';
                }
                clockEl.appendChild(span);
                numIndex++;
            }
        });
    }

    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', options);
    if (dateEl && dateEl.textContent !== dateStr) dateEl.textContent = dateStr;
};

document.addEventListener('DOMContentLoaded', () => {
    init3D();
    updateClock();
    setInterval(updateClock, 1000);
});