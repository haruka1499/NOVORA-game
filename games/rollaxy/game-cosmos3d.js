'use strict';

// ============================================================
// COSMOS 3D — Phase 2: 恒星成長を 3D に反映
// ============================================================
// Three.js を使った宇宙パネル用 3D ビューア。パネル全面を占める。
//   - 背景: space-bg.png (360° 環境マップ)
//   - 中央: 恒星（sun.png）。サイズ＝物質生成器レベル、
//           グロー光輪の色＝tier、強度＝エネルギーレートに連動
//
// 連動は game-meta.js の renderCosmos() から Cosmos3D.update() を呼ぶ。
//
// 後続フェーズ:
//   Phase 3: 公転する惑星を配置（earth/mercury/venus テクスチャ）
//   Phase 4: 超新星演出
//   Phase 7: カメラのドラッグ/ピンチ操作
// ============================================================

window.Cosmos3D = (function () {
  // tier ごとの恒星グロー色（恒星進化のイメージ: 赤色矮星 → 黄 → 白 → 青色巨星）。
  // CFG.META.STAR.TIER_LEVELS は 12 段階なので 12 色用意。
  const TIER_COLORS = [
    0x6a5a7a, // 0 原始星（くすんだ紫灰）
    0x8a5a6a, // 1
    0xff6a4d, // 2 赤
    0xff7a3d, // 3 赤橙
    0xffa840, // 4 橙
    0xffc24d, // 5 黄
    0xffe27a, // 6 黄白
    0xfff0c0, // 7 白黄
    0xffffff, // 8 白
    0xdce8ff, // 9 青白
    0xbcd4ff, // 10 青
    0x9cc0ff, // 11 濃青
  ];

  // ── GLSL: 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT) + fbm ──
  // 恒星表面の沸騰プラズマとコロナの揺らぎに使う手続き型ノイズ。
  const NOISE_GLSL = `
    vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+1.0*C.xxx; vec3 x2=x0-i2+2.0*C.xxx; vec3 x3=x0-1.0+3.0*C.xxx;
      i=mod(i,289.0);
      vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=1.0/7.0; vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
    float fbm(vec3 p){
      float a=0.5,f=0.0; for(int i=0;i<4;i++){ f+=a*snoise(p); p*=2.0; a*=0.5; } return f;
    }
  `;

  const SUN_VERT = `
    varying vec2 vUv; varying vec3 vPos; varying vec3 vNormalW; varying vec3 vViewDirW;
    void main(){
      vUv=uv; vPos=position;
      vec4 wp=modelMatrix*vec4(position,1.0);
      vNormalW=normalize(mat3(modelMatrix)*normal);
      vViewDirW=normalize(cameraPosition-wp.xyz);
      gl_Position=projectionMatrix*viewMatrix*wp;
    }
  `;
  // 表面: 「ホットスポット駆動」の色合い。
  // FBM で表面の温度マップを作り、高温部だけ白〜黄、中間は橙、低温部は赤に。
  // 発光は表面全体ではなく高温部分中心。テクスチャの模様も保つ。
  const SUN_FRAG = NOISE_GLSL + `
    uniform float uTime; uniform sampler2D uTex; uniform vec3 uColor;
    uniform float uInstability;  // 0=通常、1=超新星予兆(沸騰激化+色相青白寄り)
    varying vec2 vUv; varying vec3 vPos; varying vec3 vNormalW; varying vec3 vViewDirW;
    void main(){
      float speedMult = 1.0 + uInstability * 4.0; // 不安定時は流動高速化
      float t = uTime * 0.18 * speedMult;
      vec3 q = vPos * 2.4;
      // テクスチャを軽くドメインワープ（プラズマの流動）。不安定時は強くワープ
      float w = fbm(q + vec3(0.0, 0.0, t));
      vec2 uv2 = vUv + vec2(w) * (0.02 + uInstability * 0.06);
      vec3 base = texture2D(uTex, uv2).rgb;

      // 表面の温度マップ（球面のどの位置が高温かを FBM で）。不安定時は高周波成分追加
      float heat = fbm(q * 1.6 + vec3(t * 0.8));
      heat += fbm(q * 4.5 + vec3(t * 1.6)) * 0.5;
      heat += fbm(q * 9.0 + vec3(t * 3.0)) * uInstability * 0.6;
      heat = clamp(heat * 0.5 + 0.55 + uInstability * 0.25, 0.0, 1.0);

      // 色グラデーション: 赤 → 橙 → 黄 → 白（高温ほど白）
      vec3 cRed    = vec3(0.45, 0.05, 0.02);
      vec3 cOrange = vec3(1.10, 0.45, 0.10);
      vec3 cYellow = vec3(1.30, 0.95, 0.35);
      vec3 cWhite  = vec3(1.20, 1.10, 0.85); // 控えめに > 1
      vec3 grad = mix(cRed,    cOrange, smoothstep(0.20, 0.55, heat));
      grad     = mix(grad,     cYellow, smoothstep(0.50, 0.80, heat));
      grad     = mix(grad,     cWhite,  smoothstep(0.78, 0.96, heat));
      // ベース色合い (uColor=恒星 tier 色) で全体トーンを左右
      grad *= mix(vec3(0.7), uColor / max(uColor.r, 0.001), 0.45);

      // テクスチャの模様で陰影をつける
      float texLum = (base.r + base.g + base.b) / 3.0;
      vec3 col = grad * mix(0.6, 1.15, texLum);

      // 周縁の暖色補強（フレネル）— 控えめ
      float NdV = max(dot(vNormalW, vViewDirW), 0.0);
      float fres = pow(1.0 - NdV, 2.5);
      col += cOrange * fres * 0.35;

      // 不安定時: 色相を青白寄りに、全体を増光（崩壊直前の超高温感）
      vec3 hotBlue = vec3(1.3, 1.4, 1.8);
      col = mix(col, hotBlue, uInstability * 0.4);
      col *= 1.0 + uInstability * 1.5;

      gl_FragColor = vec4(col, 1.0);
    }
  `;
  // 炎のスパイク押し出しは廃止 (「とんがり」化問題)。
  // 外周は「ぼやっと光るハロー」(SpriteMaterial) + 球シェルの fresnel グロー で表現。
  // 動的な「炎」要素は「時々飛び出す Solar Flare」 (TubeGeometry loop) に集約。

  // ハズシェル フラグメント: 球面の外側ぎりぎりに薄い暖色グロー (fresnel ベース)
  const CORONA_HAZE_FRAG = NOISE_GLSL + `
    uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
    varying vec2 vUv; varying vec3 vPos; varying vec3 vNormalW; varying vec3 vViewDirW;
    void main(){
      float fres = pow(1.0 - max(dot(vNormalW, vViewDirW), 0.0), 2.6);
      float t = uTime * 0.25;
      float n = fbm(vPos * 1.3 + vec3(t));
      float a = fres * (0.55 + 0.45 * n) * 0.6 * uOpacity;
      a = clamp(a, 0.0, 1.0);
      gl_FragColor = vec4(uColor * a * 1.15, a);
    }
  `;

  // ── パーティクル（外周のプラズマ粒）──
  // 球面上にばらまいた小さな点が明滅する。BufferGeometry + Points で軽量。
  const PARTICLE_VERT = `
    attribute float phase;
    uniform float uTime; uniform float uPointScale;
    varying float vAlpha;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec4 mv = viewMatrix * wp;
      // 距離に応じてサイズ調整（遠いと小さく）
      gl_PointSize = uPointScale * (1.0 / -mv.z);
      // 各粒子の独立位相で明滅
      float pulse = sin(uTime * 2.5 + phase) * 0.5 + 0.5;
      vAlpha = pulse * pulse; // 鋭めの明滅
      gl_Position = projectionMatrix * mv;
    }
  `;
  const PARTICLE_FRAG = `
    uniform vec3 uColor;
    varying float vAlpha;
    void main(){
      // 円形マスク（gl_PointCoord は 0..1 の正方形）
      vec2 d = gl_PointCoord - vec2(0.5);
      float dist = length(d);
      if (dist > 0.5) discard;
      float a = smoothstep(0.5, 0.0, dist) * vAlpha;
      gl_FragColor = vec4(uColor * a * 2.2, a);
    }
  `;

  let scene, camera, renderer, starMesh, loader, planetGroup;
  let sunMat;                          // 恒星サーフェスのシェーダ
  let coronaLayers = [];               // 1 層: ハズシェル (1.18× の fresnel グロー)
  let particleSystem = null;           // 外周スパーク (小さい点が明滅)
  let particleMat = null;
  let outerHaloSprite = null;          // 大きいぼやっとしたハロー (Sprite)
  let solarFlares = [];                // [{mesh, mat, t, riseDur, peakDur, fadeDur}]
  let _nextFlareIn = 3.0;              // 次のフレア出現までの秒数 (起動 3 秒後に初回)
  let composer, bloomPass;             // EffectComposer + UnrealBloomPass

  // ── 超新星演出リソース (init で1度作成、triggerSupernova で再起動)──
  let supernovaT = 0;                  // 0 = 非演出、>0 = 演出進行時間 (秒)
  let _lastFrameT = 0;                 // dt 計算用
  let snFlashSprite = null;            // 全画面閃光 (Sprite)
  let snShockwaves = [];               // 衝撃波 球シェル [{mesh, mat, delay}]
  let snExplosionPoints = null;        // 爆発粒子 (THREE.Points)
  let snExplosionMat = null;
  let snEnergyCloud = null;            // 膨張エネルギー雲 (球メッシュ)
  let snEnergyMat = null;
  let snNebulaPoints = null;           // 残骸星雲 (Points)
  let snNebulaMat = null;
  let _camShake = 0;                   // カメラ振動の強度 (フェーズで設定)

  // 超新星演出のフェーズ境界 (秒、トリガーからの経過)
  const SN_WARN_END    = 1.8;          // 予兆 (恒星不安定)
  const SN_FLASH_PEAK  = 1.95;         // 閃光ピーク (フラッシュ最大)
  const SN_FLASH_END   = 2.2;          // 閃光終わり
  const SN_EXPAND_END  = 5.2;          // 拡散フェーズ終わり
  const SN_TOTAL       = 7.5;          // 全体終了 (残骸も含む)
  // 品質依存パーティクル数
  const QUALITY_SN = {
    HIGH: { explosionParts: 1200, nebulaParts: 400 },
    MID:  { explosionParts: 600,  nebulaParts: 200 },
    LOW:  { explosionParts: 300,  nebulaParts: 100 },
  };

  // ── 動的品質（Phase 7）──
  // HIGH: 全機能 / MID: 中間 / LOW: 軽量。起動時HIGH、fps が画面更新の90%を下回ったら段階的に下げる
  // 押し出し量は球半径(=1.0)に対する割合。0.03〜0.08 程度に抑えて「ほぼ球+細い炎の舌」を実現。
  // geomDetail は SphereGeometry の widthSegments。高分割で押し出しエッジを滑らかに見せる。
  // hazeOpacity = 球シェルの外周 fresnel グロー強度
  // haloOpacity = 大きい外側ハロー Sprite の不透明度
  // particleCount = 周辺スパーク数
  // flareMax = 同時に存在できる Solar Flare 最大数
  const QUALITY = {
    HIGH: { hazeOpacity: 0.7, haloOpacity: 0.28, particleCount: 50, flareMax: 2 },
    MID:  { hazeOpacity: 0.6, haloOpacity: 0.22, particleCount: 25, flareMax: 2 },
    LOW:  { hazeOpacity: 0.5, haloOpacity: 0.16, particleCount: 10, flareMax: 1 },
  };
  let qualityLevel = 'HIGH';

  // fps 計測
  let _fpsFrames = [];
  let _fpsStartT = 0;
  let _fpsTarget = null;               // 画面リフレッシュレート（起動後2秒で確定）
  let _lastQualityChange = 0;

  // ── カメラ操作（Phase 7）──
  let camTheta = 0;                    // 方位角（rad）
  let camPhi   = Math.PI / 2;          // 仰角（rad、π/2=赤道）
  let camRadius = 3.4;                 // 距離
  const CAM_MIN_R = 1.8, CAM_MAX_R = 7.0;
  const CAM_PHI_PAD = 0.15;            // 極での詰まりを防ぐマージン
  let _userInteractUntil = 0;          // この時刻まで自動回転停止
  let _pointers = new Map();           // pointerId → {x,y}
  let _pinchPrevDist = 0;
  let animId = null;
  let initialized = false;
  let pulseT = 0;

  // 惑星（Phase 3）
  let planetObjs   = [];   // [{ mesh, orbitRadius, angle, speed }]
  let planetsSig   = '';   // 現在の惑星構成シグネチャ（変化時のみ再構築）
  const planetTexCache = {}; // key -> THREE.Texture（再ロード回避）

  // 最新の連動パラメータ（update で更新、アニメループで反映）
  const target = {
    radius:    0.5,
    glowColor: TIER_COLORS[0],
    glowScale: 1.6,
    glowOpacity: 0.4,
  };
  // 現在値（target へなめらかに補間）
  const cur = { radius: 0.5, glowScale: 1.6, glowOpacity: 0.4 };

  function _wrap()   { return document.getElementById('cosmos-3d-wrap'); }
  function _canvas() { return document.getElementById('cosmos-3d'); }

  // テクスチャを NPOT セーフに（WebGL1 黒化回避）
  function _npotSafe(tex) {
    tex.colorSpace      = THREE.SRGBColorSpace;
    tex.minFilter       = THREE.LinearFilter;
    tex.magFilter       = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  // 放射状グラデーション（中心白→外周透明）の Sprite テクスチャを動的生成
  function _makeGlowTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function init() {
    if (initialized) return;
    if (typeof THREE === 'undefined') {
      console.warn('[cosmos3d] THREE.js が読み込めませんでした。3D 表示はスキップします。');
      return;
    }
    const canvas = _canvas();
    const wrap   = _wrap();
    if (!canvas || !wrap) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (w < 10 || h < 10) { setTimeout(init, 200); return; } // サイズ未確定なら再試行
    initialized = true;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(0, 0, 3.4);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    // Bloom が綺麗に乗るよう ACES Filmic + 露出を抑えめ（眩しすぎ防止）
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.7;

    loader = new THREE.TextureLoader();
    // 背景（360° 環境マップ）
    loader.load('images/cosmos/space-bg.jpg',
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        _npotSafe(tex);
        scene.background = tex;
      },
      undefined,
      (err) => console.warn('[cosmos3d] 背景テクスチャ読込失敗', err)
    );

    // 恒星サーフェス: sun テクスチャを手続き型ノイズで沸騰・流動させる ShaderMaterial。
    // 単なる貼り付け（プラスチック球）ではなく、生きたプラズマの揺らぎを表現。
    const sunTex = _npotSafe(loader.load('images/cosmos/sun.jpg'));
    sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uTex:         { value: sunTex },
        uColor:       { value: new THREE.Color(target.glowColor) },
        uInstability: { value: 0 },
      },
      vertexShader:   SUN_VERT,
      fragmentShader: SUN_FRAG,
    });
    starMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), sunMat);
    scene.add(starMesh);

    // コロナ: 頂点押し出しの炎の舌層 + 滑らかな遠方ヘイズの 2 層構成。
    // CORONA_VERT で頂点自体を法線方向にノイズ押し出しするため、輪郭が円ではなくなる。
    const q = QUALITY[qualityLevel];
    // ハズシェル: 球サイズの少し上 (1.15×) で fresnel ベースの暖色グロー (1 層のみ)
    const hazeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:    { value: 0 },
        uColor:   { value: new THREE.Color(target.glowColor) },
        uOpacity: { value: q.hazeOpacity },
      },
      vertexShader:   SUN_VERT,
      fragmentShader: CORONA_HAZE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
      side:           THREE.FrontSide,
    });
    const hazeMesh = new THREE.Mesh(new THREE.SphereGeometry(1.15, 64, 32), hazeMat);
    scene.add(hazeMesh);
    coronaLayers.push({ mesh: hazeMesh, mat: hazeMat, baseScale: 1.15, speed: 0.0005 });

    // 外側ハロー (Sprite): 大きく、ぼやっとした「光が周囲に滲んでる」感覚
    const haloMat = new THREE.SpriteMaterial({
      map: _makeGlowTexture(),
      color: target.glowColor,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: q.haloOpacity,
    });
    outerHaloSprite = new THREE.Sprite(haloMat);
    outerHaloSprite.scale.set(3.2, 3.2, 1);
    scene.add(outerHaloSprite);

    // 外周プラズマ粒子（炎の周りを舞うスパーク）
    _initParticles(q.particleCount);

    // カメラ操作（ドラッグ回転 + ピンチ/ホイールズーム）
    _initCameraControls();
    _fpsStartT = performance.now();

    // glowSprite / outerHaloSprite / solarFlares は削除:
    //   - 巨大スプライトを重ねるだけ → 「球が重なって見える/謎リング」原因
    //   - 大きい弧フレア → 「短く細かい炎を大量」という方針と不一致
    // 外周 Glow は CORONA_HAZE_FRAG (1.18×シェル) が担う。

    // 惑星用ライト: 恒星（原点）から放射する点光源 + 弱い環境光（暗黒面が真っ黒にならないよう）
    const starLight = new THREE.PointLight(0xfff2dd, 2.4, 0, 0.0);
    starLight.position.set(0, 0, 0);
    scene.add(starLight);
    scene.add(new THREE.AmbientLight(0x404a66, 0.6));

    // 惑星の公転グループ（少し傾けて 3D の奥行きを出す）
    planetGroup = new THREE.Group();
    planetGroup.rotation.x = -0.5; // 約 -28°
    scene.add(planetGroup);

    // EffectComposer + UnrealBloomPass。
    // まず Bloom を弱めて炎・色合いの本体を整える → 最後にもう一段強めて仕上げ。
    if (window.EffectComposer && window.UnrealBloomPass) {
      composer  = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h),
        0.25,  // strength: 弱め（作業中の基準）
        0.5,   // radius: 拡散半径
        0.85   // threshold: かなり明るい画素のみ Bloom 対象
      );
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());
    } else {
      console.warn('[cosmos3d] UnrealBloomPass 未ロード。Bloom なしで描画継続');
    }

    // 超新星リソースを 1 度作成（不可視で待機、triggerSupernova で起動）
    _initSupernovaResources();

    window.addEventListener('resize', _onResize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(_onResize).observe(wrap);

    _start();
  }

  // ── ソーラーフレア (粒子ストリーム + 渦巻きノイズ = 「煙が吹き出して渦巻く」感) ──
  // 経路: A(始点) → Apex(頂点・恒星外側) → B(終点) の二次ベジエ
  // 各粒子は独立位相 tOffset で経路上を循環し、3軸ノイズで揺らぐ = 連続噴き出し+渦
  // 寿命: rise → peak → fade を uLife で全体不透明度として制御
  const FLARE_VERT = `
    attribute float tOffset;
    uniform float uTime;
    uniform vec3 uA;
    uniform vec3 uApex;
    uniform vec3 uB;
    uniform float uLife;
    varying float vAlpha;
    varying float vT;
    void main(){
      // 経路上の位置 t = (tOffset + uTime*speed) を 0..1 で循環
      float t = mod(tOffset + uTime * 0.16, 1.0);
      vT = t;
      // 二次ベジエ補間
      float ot = 1.0 - t;
      vec3 path = ot*ot*uA + 2.0*ot*t*uApex + t*t*uB;
      // 中央(t=0.5)ほど膨らみ最大、端で 0 (経路に張り付く = 煙の根元)
      float spread = sin(t * 3.14159);
      // 3軸サイン波で「渦巻く」揺らぎ。spread で端を抑制
      float w = uTime * 1.4 + tOffset * 17.0;
      vec3 swirl = vec3(
        sin(w * 1.3),
        cos(w * 1.1 + tOffset * 9.0),
        sin(w * 0.9 + tOffset * 13.0)
      ) * 0.10 * spread;
      // 加えて、軌道接線方向に螺旋（より「渦」感）
      vec3 tangent = normalize(2.0*ot*(uApex-uA) + 2.0*t*(uB-uApex));
      vec3 perpA = normalize(cross(tangent, vec3(0.0, 1.0, 0.0) + vec3(0.001)));
      vec3 perpB = normalize(cross(tangent, perpA));
      float spiral = t * 6.28318 + uTime * 1.6 + tOffset * 12.0;
      vec3 helix = (perpA * cos(spiral) + perpB * sin(spiral)) * 0.06 * spread;
      vec3 pos = path + swirl + helix;
      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      // 中央ほど大きい粒(煙の膨らみ)
      gl_PointSize = (8.0 + 26.0 * spread) / -mv.z;
      vAlpha = spread * uLife;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const FLARE_FRAG = `
    uniform vec3 uColor;
    varying float vAlpha;
    varying float vT;
    void main(){
      // 円形ソフトマスク (gl_PointCoord 0..1)
      vec2 d = gl_PointCoord - vec2(0.5);
      float dist = length(d);
      if (dist > 0.5) discard;
      float fall = smoothstep(0.5, 0.0, dist);
      float a = fall * vAlpha;
      // 中央 (vT ~0.5) ほど白寄り高温、端ほどベース色寄り
      float hot = 1.0 - abs(vT - 0.5) * 2.0; // 0..1
      vec3 col = mix(uColor, vec3(1.6, 1.2, 0.7), hot * 0.45);
      gl_FragColor = vec4(col * a * 1.6, a);
    }
  `;

  // ── 超新星 爆発粒子シェーダ ──
  // 各粒子は velocity(初期方向×速度) と lifetime を attribute で持つ。
  // 位置は velocity * uT で原点から放射状に広がる。
  // 色は時間で 白 → 黄 → 橙 → 赤 → 透明 と冷却。
  const EXPLOSION_VERT = `
    attribute vec3 velocity;
    attribute float lifetime;
    uniform float uT;
    varying float vP;     // 寿命進行率 0..1
    varying float vSpeed;
    void main(){
      // 原点から velocity の方向に時間進行
      vec3 pos = velocity * uT;
      vP = uT / lifetime;
      vSpeed = length(velocity);
      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      // 粒子サイズ: 時間と共に縮小、速い粒子ほど大きく
      float size = (12.0 + 18.0 * (1.0 - clamp(vP, 0.0, 1.0))) * (0.7 + vSpeed * 0.5);
      gl_PointSize = size / -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;
  const EXPLOSION_FRAG = `
    varying float vP;
    varying float vSpeed;
    void main(){
      if (vP > 1.0) discard;
      vec2 d = gl_PointCoord - vec2(0.5);
      float dist = length(d);
      if (dist > 0.5) discard;
      float fall = smoothstep(0.5, 0.0, dist);
      // 色冷却: vP=0 白 → 0.3 黄 → 0.6 橙 → 0.9 暗赤 → 1.0 消失
      vec3 cWhite  = vec3(1.5, 1.4, 1.1);
      vec3 cYellow = vec3(1.4, 1.0, 0.4);
      vec3 cOrange = vec3(1.2, 0.55, 0.15);
      vec3 cRed    = vec3(0.6, 0.12, 0.05);
      vec3 col = mix(cWhite, cYellow, smoothstep(0.0, 0.3, vP));
      col = mix(col, cOrange, smoothstep(0.25, 0.6, vP));
      col = mix(col, cRed,    smoothstep(0.55, 0.95, vP));
      float a = fall * (1.0 - smoothstep(0.7, 1.0, vP));
      gl_FragColor = vec4(col * a * 1.6, a);
    }
  `;

  // ── 衝撃波シェル: 球面の silhouette だけ強いリングとして光る ──
  // 球をスケールアップ + 不透明度フェードで「拡大するリング」に見せる
  const SHOCKWAVE_VERT = `
    varying vec3 vN;
    varying vec3 vV;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  const SHOCKWAVE_FRAG = `
    uniform float uOpacity;
    uniform vec3 uColor;
    varying vec3 vN;
    varying vec3 vV;
    void main(){
      float fres = pow(1.0 - max(dot(vN, vV), 0.0), 8.0);
      float a = fres * uOpacity;
      gl_FragColor = vec4(uColor * a * 2.5, a);
    }
  `;

  // ── エネルギー雲: 緩やかに膨張する半透明シェル ──
  const ENERGY_CLOUD_FRAG = NOISE_GLSL + `
    uniform float uT;
    uniform float uMaxT;
    uniform vec3 uColor;
    varying vec3 vPos;
    varying vec3 vNormalW;
    varying vec3 vViewDirW;
    void main(){
      float fres = pow(1.0 - max(dot(vNormalW, vViewDirW), 0.0), 2.0);
      float n = fbm(vPos * 1.5 + vec3(uT * 0.5));
      // 時間経過でフェード
      float fade = 1.0 - smoothstep(0.0, uMaxT, uT);
      float a = (fres * 0.6 + n * 0.4) * fade * 0.55;
      a = clamp(a, 0.0, 1.0);
      vec3 col = mix(uColor, vec3(1.6, 1.0, 0.5), n * 0.4);
      gl_FragColor = vec4(col * a * 1.4, a);
    }
  `;

  // ── 残骸星雲: ゆっくり漂う粒子 ──
  const NEBULA_VERT = `
    attribute vec3 velocity;
    attribute float seed;
    uniform float uT;
    uniform float uDecay;  // 0=新鮮 1=消滅
    varying float vAlpha;
    varying float vSeed;
    void main(){
      // 拡散後にゆっくり漂う: position = velocity * t * 0.4 + initial
      vec3 pos = velocity * uT * 0.4;
      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_PointSize = (14.0 + 10.0 * fract(seed)) / -mv.z;
      vSeed = seed;
      vAlpha = (1.0 - uDecay) * (0.5 + 0.4 * fract(seed * 7.0));
      gl_Position = projectionMatrix * mv;
    }
  `;
  const NEBULA_FRAG = `
    uniform vec3 uColor;
    varying float vAlpha;
    varying float vSeed;
    void main(){
      vec2 d = gl_PointCoord - vec2(0.5);
      float dist = length(d);
      if (dist > 0.5) discard;
      float fall = smoothstep(0.5, 0.0, dist);
      // 粒ごとに色合いを少しずらす (青→紫→ピンクっぽい星雲)
      vec3 c1 = vec3(0.45, 0.18, 0.65);
      vec3 c2 = vec3(0.85, 0.35, 0.55);
      vec3 col = mix(c1, c2, fract(vSeed * 13.0));
      col = mix(col, uColor, 0.35);
      gl_FragColor = vec4(col * fall * vAlpha * 1.2, fall * vAlpha);
    }
  `;

  function _randUnitVec() {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
  }
  function _spawnFlare() {
    // 経路の 3 制御点 (A: 表面始点, Apex: 外側頂点, B: 表面終点)
    const a = _randUnitVec();
    const offset = _randUnitVec().multiplyScalar(0.22 + Math.random() * 0.25);
    const b = a.clone().add(offset).normalize();
    const midDir = a.clone().add(b).multiplyScalar(0.5).normalize();
    const apexH = 1.55 + Math.random() * 0.55;
    const apex = midDir.clone().multiplyScalar(apexH);
    const sideways = new THREE.Vector3();
    sideways.crossVectors(midDir, new THREE.Vector3(0, 1, 0)).normalize();
    if (!isFinite(sideways.x)) sideways.set(1, 0, 0);
    apex.addScaledVector(sideways, (Math.random() - 0.5) * 0.35);

    // 粒子: 経路上に分散配置 (実位置は VS で計算するため position は dummy)
    const N = 80;
    const positions = new Float32Array(N * 3);
    const tOffsets  = new Float32Array(N);
    for (let i = 0; i < N; i++) tOffsets[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('tOffset',  new THREE.BufferAttribute(tOffsets, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:  { value: 0 },
        uA:     { value: a },
        uApex:  { value: apex },
        uB:     { value: b },
        uLife:  { value: 0 },
        uColor: { value: new THREE.Color(0xffae50) },
      },
      vertexShader:   FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
    });
    return {
      mesh: new THREE.Points(geo, mat),
      mat,
      t: 0,
      riseDur: 1.6 + Math.random() * 1.2,
      peakDur: 2.0 + Math.random() * 2.0,  // ピーク長めで「煙が出続ける」時間を確保
      fadeDur: 3.5 + Math.random() * 2.0,
    };
  }
  function _updateSolarFlares(dt) {
    for (let i = solarFlares.length - 1; i >= 0; i--) {
      const f = solarFlares[i];
      f.t += dt;
      const total = f.riseDur + f.peakDur + f.fadeDur;
      if (f.t >= total) {
        scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mat.dispose();
        solarFlares.splice(i, 1);
        continue;
      }
      let alpha;
      if (f.t < f.riseDur) {
        alpha = f.t / f.riseDur;
      } else if (f.t < f.riseDur + f.peakDur) {
        alpha = 1.0;
      } else {
        alpha = 1.0 - (f.t - f.riseDur - f.peakDur) / f.fadeDur;
      }
      alpha = alpha * alpha * (3.0 - 2.0 * alpha);
      f.mat.uniforms.uLife.value = alpha;
      f.mat.uniforms.uTime.value = pulseT;
      f.mesh.scale.setScalar(cur.radius);
    }
    _nextFlareIn -= dt;
    const limit = QUALITY[qualityLevel].flareMax;
    if (_nextFlareIn <= 0 && solarFlares.length < limit) {
      const f = _spawnFlare();
      scene.add(f.mesh);
      solarFlares.push(f);
      _nextFlareIn = 8 + Math.random() * 17;
    }
  }

  function _onResize() {
    if (!initialized) return;
    const wrap = _wrap();
    if (!wrap) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (w < 10 || h < 10) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (composer)  composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }

  // ── パーティクル（外周プラズマ）──
  function _initParticles(count) {
    if (particleSystem) { scene.remove(particleSystem); particleSystem.geometry.dispose(); particleMat.dispose(); particleSystem = null; }
    if (count <= 0) return;
    const positions = new Float32Array(count * 3);
    const phases    = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // 球面上のランダム点 × 半径バリエーション（1.3〜2.0）
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = 1.3 + Math.random() * 0.7;
      const sx = Math.sqrt(1 - u * u);
      positions[i * 3]     = sx * Math.cos(a) * r;
      positions[i * 3 + 1] = u * r;
      positions[i * 3 + 2] = sx * Math.sin(a) * r;
      phases[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('phase',    new THREE.BufferAttribute(phases, 1));
    particleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uColor:      { value: new THREE.Color(target.glowColor) },
        uPointScale: { value: 12 },
      },
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
    });
    particleSystem = new THREE.Points(geo, particleMat);
    scene.add(particleSystem);
  }

  // ── 超新星リソース初期化 (1 度だけ作成、reset で再起動) ──
  function _initSupernovaResources() {
    const q = QUALITY_SN[qualityLevel];

    // 全画面閃光 Sprite (radial gradient、デフォルト不可視)
    const flashMat = new THREE.SpriteMaterial({
      map: _makeGlowTexture(),
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    snFlashSprite = new THREE.Sprite(flashMat);
    snFlashSprite.scale.set(15, 15, 1);
    snFlashSprite.visible = false;
    scene.add(snFlashSprite);

    // 衝撃波 球シェル × 3 (staggered delay で連続的に拡大)
    const swColor = new THREE.Color(0xffd870);
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 0 }, uColor: { value: swColor } },
        vertexShader:   SHOCKWAVE_VERT,
        fragmentShader: SHOCKWAVE_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
      mesh.visible = false;
      scene.add(mesh);
      snShockwaves.push({ mesh, mat, delay: i * 0.15, speed: 4.5 + i * 1.2 });
    }

    // 爆発粒子: 最大数で確保し、tier ごとに有効粒子を制御
    const N = q.explosionParts;
    const positions = new Float32Array(N * 3); // dummy
    const velocities = new Float32Array(N * 3);
    const lifetimes  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // ランダム単位球方向 + ランダム速度
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = 0.3 + Math.random() * 1.5;
      velocities[i*3]     = s * Math.cos(a) * speed;
      velocities[i*3 + 1] = u * speed;
      velocities[i*3 + 2] = s * Math.sin(a) * speed;
      lifetimes[i] = 1.5 + Math.random() * 2.0;
    }
    const exGeo = new THREE.BufferGeometry();
    exGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    exGeo.setAttribute('velocity', new THREE.BufferAttribute(velocities, 3));
    exGeo.setAttribute('lifetime', new THREE.BufferAttribute(lifetimes, 1));
    snExplosionMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 } },
      vertexShader:   EXPLOSION_VERT,
      fragmentShader: EXPLOSION_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    snExplosionPoints = new THREE.Points(exGeo, snExplosionMat);
    snExplosionPoints.visible = false;
    scene.add(snExplosionPoints);

    // エネルギー雲 (膨張球)
    snEnergyMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uMaxT: { value: 3.0 }, uColor: { value: new THREE.Color(0xff7a30) } },
      vertexShader:   SUN_VERT,
      fragmentShader: ENERGY_CLOUD_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    snEnergyCloud = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), snEnergyMat);
    snEnergyCloud.visible = false;
    scene.add(snEnergyCloud);

    // 残骸星雲 (Points)
    const M = q.nebulaParts;
    const nebPos = new Float32Array(M * 3);
    const nebVel = new Float32Array(M * 3);
    const nebSeed = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const sp = 0.15 + Math.random() * 0.4;
      nebVel[i*3]     = s * Math.cos(a) * sp;
      nebVel[i*3 + 1] = u * sp;
      nebVel[i*3 + 2] = s * Math.sin(a) * sp;
      nebSeed[i] = Math.random() * 100;
    }
    const nebGeo = new THREE.BufferGeometry();
    nebGeo.setAttribute('position', new THREE.BufferAttribute(nebPos, 3));
    nebGeo.setAttribute('velocity', new THREE.BufferAttribute(nebVel, 3));
    nebGeo.setAttribute('seed',     new THREE.BufferAttribute(nebSeed, 1));
    snNebulaMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uDecay: { value: 1 }, uColor: { value: new THREE.Color(0xff8060) } },
      vertexShader:   NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    snNebulaPoints = new THREE.Points(nebGeo, snNebulaMat);
    snNebulaPoints.visible = false;
    scene.add(snNebulaPoints);
  }

  // ── カメラ操作 ──
  function _updateCamera() {
    const x = camRadius * Math.sin(camPhi) * Math.sin(camTheta);
    const y = camRadius * Math.cos(camPhi);
    const z = camRadius * Math.sin(camPhi) * Math.cos(camTheta);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
  }
  function _initCameraControls() {
    const canvas = _canvas();
    if (!canvas) return;
    canvas.style.touchAction = 'none'; // ブラウザのジェスチャを抑止し pointer events を取り切る
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (_pointers.size === 2) {
        const a = [..._pointers.values()];
        _pinchPrevDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      }
      _userInteractUntil = performance.now() + 100000; // 操作中は自動回転停止
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!_pointers.has(e.pointerId)) return;
      const prev = _pointers.get(e.pointerId);
      const curX = e.clientX, curY = e.clientY;
      if (_pointers.size === 1) {
        // ドラッグ回転
        const dx = curX - prev.x, dy = curY - prev.y;
        camTheta -= dx * 0.008;
        camPhi   = Math.max(CAM_PHI_PAD, Math.min(Math.PI - CAM_PHI_PAD, camPhi - dy * 0.008));
        _updateCamera();
      } else if (_pointers.size >= 2) {
        // ピンチ
        _pointers.set(e.pointerId, { x: curX, y: curY });
        const a = [..._pointers.values()];
        const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (_pinchPrevDist > 0) {
          const factor = _pinchPrevDist / dist;
          camRadius = Math.max(CAM_MIN_R, Math.min(CAM_MAX_R, camRadius * factor));
          _updateCamera();
        }
        _pinchPrevDist = dist;
        return;
      }
      _pointers.set(e.pointerId, { x: curX, y: curY });
    });
    function _release(e) {
      _pointers.delete(e.pointerId);
      if (_pointers.size < 2) _pinchPrevDist = 0;
      if (_pointers.size === 0) {
        // 操作終了の 2 秒後に自動回転を再開
        _userInteractUntil = performance.now() + 2000;
      }
    }
    canvas.addEventListener('pointerup',     _release);
    canvas.addEventListener('pointercancel', _release);
    canvas.addEventListener('pointerleave',  _release);
    // マウスホイールでズーム（passive:false で preventDefault 可能に）
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : (1 / 1.1);
      camRadius = Math.max(CAM_MIN_R, Math.min(CAM_MAX_R, camRadius * factor));
      _userInteractUntil = performance.now() + 2000;
      _updateCamera();
    }, { passive: false });
    _updateCamera();
  }

  // ── 動的品質（fps を測定し、画面リフレッシュレートの 90% を下回ったら品質を下げる）──
  function _trackFps(now) {
    _fpsFrames.push(now);
    while (_fpsFrames.length > 0 && _fpsFrames[0] < now - 1000) _fpsFrames.shift();
    const fps = _fpsFrames.length;
    // 起動後 2 秒の最大 fps を画面リフレッシュレートと見なす
    if (_fpsTarget === null && now - _fpsStartT > 2000) {
      _fpsTarget = Math.max(60, fps); // 最低 60 を保証
    }
    if (_fpsTarget == null) return;
    // 一度下げたら最低 10 秒は再評価しない
    if (now - _lastQualityChange < 10000) return;
    if (fps < _fpsTarget * 0.9 && qualityLevel !== 'LOW') {
      _lastQualityChange = now;
      _downgradeQuality();
    }
  }
  function _downgradeQuality() {
    const next = qualityLevel === 'HIGH' ? 'MID' : 'LOW';
    qualityLevel = next;
    const q = QUALITY[next];
    // コロナの押し出し量とヘイズ不透明度を更新（メッシュ作り直さず uniform のみ）
    if (coronaLayers[0]) coronaLayers[0].mat.uniforms.uDisplace.value = q.tongueDisplace;
    if (coronaLayers[1] && coronaLayers[1].mat.uniforms.uOpacity) coronaLayers[1].mat.uniforms.uOpacity.value = q.hazeOpacity;
    // パーティクル数を変更（再構築）
    _initParticles(q.particleCount);
    console.info('[cosmos3d] quality →', next, 'fps target=' + _fpsTarget);
  }

  function _animate() {
    animId = requestAnimationFrame(_animate);
    const now = performance.now();
    pulseT += 0.02;
    _trackFps(now);

    // target へなめらかに補間（生成器強化時のサイズ変化を滑らかに見せる）
    cur.radius      += (target.radius      - cur.radius)      * 0.08;
    cur.glowScale   += (target.glowScale   - cur.glowScale)   * 0.08;
    cur.glowOpacity += (target.glowOpacity - cur.glowOpacity) * 0.08;

    if (starMesh) {
      starMesh.rotation.y += 0.0025;
      starMesh.scale.setScalar(cur.radius);
    }
    if (sunMat) sunMat.uniforms.uTime.value = pulseT;
    // コロナ層を更新（半径追従、別速度回転で躍動感）
    for (const L of coronaLayers) {
      L.mat.uniforms.uTime.value = pulseT;
      L.mesh.scale.setScalar(cur.radius);
      L.mesh.rotation.y += L.speed;
    }
    // パーティクル更新（恒星半径に追従して外周を広げる）
    if (particleSystem) {
      particleMat.uniforms.uTime.value = pulseT;
      particleSystem.scale.setScalar(cur.radius);
    }
    // 外側ぼやっとハロー: 大きく、ゆっくり脈動
    if (outerHaloSprite) {
      const s = cur.radius * 3.2;
      outerHaloSprite.scale.set(s, s, 1);
      outerHaloSprite.material.opacity =
        (QUALITY[qualityLevel].haloOpacity) * (0.85 + 0.15 * Math.sin(pulseT * 0.4));
    }
    // ソーラーフレア: 時々飛び出す
    _updateSolarFlares(1 / 60);
    // 自動回転（ユーザー操作直後の冷却期間中は停止）
    if (now > _userInteractUntil) {
      camTheta += 0.0015;
      _updateCamera();
    }
    // カメラ振動 (超新星の予兆・閃光時のみ)
    if (_camShake > 0) {
      camera.position.x += (Math.random() - 0.5) * _camShake;
      camera.position.y += (Math.random() - 0.5) * _camShake;
      camera.position.z += (Math.random() - 0.5) * _camShake * 0.5;
    }
    // 惑星の公転 + 自転
    for (const p of planetObjs) {
      p.angle += p.speed;
      p.mesh.position.set(Math.cos(p.angle) * p.orbitRadius, 0, Math.sin(p.angle) * p.orbitRadius);
      p.mesh.rotation.y += 0.01;
    }
    // 超新星演出: 4 フェーズ (予兆 → 閃光 → 拡散 → 残骸)
    if (supernovaT > 0) {
      // dt 計算 (実時間ベース、frame rate 非依存)
      const dt = _lastFrameT ? Math.min(0.1, (now - _lastFrameT) / 1000) : 1/60;
      supernovaT += dt;
      const t = supernovaT;
      _updateSupernovaAnim(t, dt);
    }
    _lastFrameT = now;
    // 描画: EffectComposer があれば Bloom 付き、なければ通常レンダラ
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  function _start() { if (animId === null) _animate(); }
  function _stop()  { if (animId !== null) { cancelAnimationFrame(animId); animId = null; } }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _stop();
    else if (initialized) _start();
  });

  // ── 外部 API: メタ進行を 3D に反映 ──
  // state = { level, tier, energyRate }
  function update(state) {
    if (!state) return;
    const level = Math.max(1, state.level || 1);
    const tier  = Math.max(0, Math.min(TIER_COLORS.length - 1, state.tier || 0));
    const er    = Math.max(0, state.energyRate || 0);

    // サイズ: レベルを対数カーブで 0..1 に正規化 → 半径 0.45〜1.25
    const t = Math.min(1, Math.log(level + 1) / Math.log(101));
    target.radius    = 0.45 + 0.8 * t;
    target.glowColor = TIER_COLORS[tier];
    // 光輪サイズは恒星半径に追従、強度はエネルギーレートで上乗せ
    const erNorm = Math.min(1, er / 2);
    target.glowScale   = target.radius * (2.4 + 1.2 * erNorm);
    target.glowOpacity = 0.32 + 0.4 * erNorm;

    if (sunMat) sunMat.uniforms.uColor.value.setHex(target.glowColor);
    for (const L of coronaLayers) L.mat.uniforms.uColor.value.setHex(target.glowColor);
    if (particleMat) particleMat.uniforms.uColor.value.setHex(target.glowColor);
    if (outerHaloSprite) outerHaloSprite.material.color.setHex(target.glowColor);
  }

  // ── 外部 API: 惑星リストを 3D に反映 ──
  // planets = [{ key, name }]。構成（key の並び）が変わったときだけメッシュを再構築する。
  function setPlanets(planets) {
    if (!initialized || !planetGroup) return;
    planets = Array.isArray(planets) ? planets : [];
    const sig = planets.map(p => p.key).join(',');
    if (sig === planetsSig) return; // 変化なし
    planetsSig = sig;

    // 既存メッシュ破棄
    for (const p of planetObjs) {
      planetGroup.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      _removeOrbitLine(p);
    }
    planetObjs = [];

    // 再構築
    planets.forEach((pl, i) => {
      let tex = planetTexCache[pl.key];
      if (!tex) {
        tex = _npotSafe(loader.load('images/cosmos/' + pl.key + '.jpg'));
        planetTexCache[pl.key] = tex;
      }
      const orbitRadius = 1.7 + i * 0.55;
      const size = 0.13 + (pl.key === 'earth' ? 0.02 : 0);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 32, 16),
        new THREE.MeshLambertMaterial({ map: tex })
      );
      // 惑星ごとに開始角を散らし、外側ほどゆっくり公転（見た目のケプラー風）
      const angle = (i / Math.max(1, planets.length)) * Math.PI * 2;
      const speed = 0.012 / (1 + i * 0.35);
      const obj = { mesh, orbitRadius, angle, speed, orbitLine: null };
      planetGroup.add(mesh);
      _addOrbitLine(obj);
      planetObjs.push(obj);
    });
  }

  // 公転軌道を表す薄い円リング（LineLoop）
  function _addOrbitLine(obj) {
    const seg = 96, pts = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(Math.cos(a) * obj.orbitRadius, 0, Math.sin(a) * obj.orbitRadius);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.LineBasicMaterial({ color: 0x7c5cfc, transparent: true, opacity: 0.22 });
    const line = new THREE.LineLoop(g, m);
    obj.orbitLine = line;
    planetGroup.add(line);
  }
  function _removeOrbitLine(obj) {
    if (!obj.orbitLine) return;
    planetGroup.remove(obj.orbitLine);
    obj.orbitLine.geometry.dispose();
    obj.orbitLine.material.dispose();
    obj.orbitLine = null;
  }

  // DOM + ライブラリ両方の準備完了で init。
  // ライブラリ (THREE + UnrealBloomPass) は ES モジュール経由なので DOMContentLoaded より後に
  // 準備完了 → window.cosmos-libs-ready イベントで通知される。
  let _domReady = false, _libsReady = !!window.__cosmosLibsReady;
  function _maybeInit() {
    if (_domReady && _libsReady) init();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _domReady = true; _maybeInit(); });
  } else {
    _domReady = true;
  }
  window.addEventListener('cosmos-libs-ready', () => { _libsReady = true; _maybeInit(); });
  // 既にライブラリが ready なら即 init を試みる
  if (_libsReady) _maybeInit();

  // ── 外部 API: 超新星演出を発火（約2秒）──
  function triggerSupernova() {
    if (!initialized) return;
    supernovaT = 0.001;
    _lastFrameT = 0; // dt 計算をリセット (初フレームで小さい dt)
    // 衝撃波の再起動 (前回演出で破棄してるかもしれないので visible リセット)
    for (const sw of snShockwaves) {
      sw.mesh.visible = true;
      sw.mat.uniforms.uOpacity.value = 0;
      sw.mesh.scale.setScalar(0.5);
    }
    if (snFlashSprite)    { snFlashSprite.visible = true;    snFlashSprite.material.opacity = 0; }
    if (snExplosionPoints){ snExplosionPoints.visible = false; }
    if (snEnergyCloud)    { snEnergyCloud.visible = false; }
    if (snNebulaPoints)   { snNebulaPoints.visible = false; }
  }

  // 超新星演出のメインアップデート (フェーズごとに各要素を制御)
  function _updateSupernovaAnim(t, dt) {
    // フェーズ A: 予兆 (恒星不安定化、脈動、軽振動)
    if (t < SN_WARN_END) {
      const p = t / SN_WARN_END; // 0..1
      const ease = p * p; // 加速度的に
      if (sunMat) sunMat.uniforms.uInstability.value = ease;
      // 高速脈動 (sin 周波数を増す)
      const pulseFreq = 6 + ease * 30;
      const pulseAmp  = 0.05 + ease * 0.15;
      const pulseScale = 1 + Math.sin(t * pulseFreq) * pulseAmp;
      if (starMesh)  starMesh.scale.setScalar(cur.radius * pulseScale);
      for (const L of coronaLayers) L.mesh.scale.setScalar(cur.radius * pulseScale);
      _camShake = ease * 0.04;
      return;
    }
    // フェーズ B: 閃光・爆発の瞬間
    if (t < SN_FLASH_END) {
      const localT = t - SN_WARN_END;       // 0..0.4
      const flashP = localT / (SN_FLASH_END - SN_WARN_END);
      // 閃光: 立ち上がり 0→1 (~0.15s) → fade 1→0 (~0.25s)
      let flashOpacity;
      const peakT = (SN_FLASH_PEAK - SN_WARN_END) / (SN_FLASH_END - SN_WARN_END);
      if (flashP < peakT) flashOpacity = flashP / peakT;
      else flashOpacity = 1 - (flashP - peakT) / (1 - peakT);
      flashOpacity = Math.max(0, Math.min(1, flashOpacity));
      if (snFlashSprite) snFlashSprite.material.opacity = flashOpacity * 0.95;

      // 恒星本体を急速縮小 → 閃光終わり頃に消える
      const k = Math.max(0, 1 - flashP * 1.8);
      if (starMesh)  starMesh.scale.setScalar(cur.radius * k);
      for (const L of coronaLayers) L.mesh.scale.setScalar(cur.radius * k);
      _camShake = 0.12 * (1 - flashP);

      // 爆発粒子を起動
      if (snExplosionPoints && !snExplosionPoints.visible) snExplosionPoints.visible = true;
      if (snExplosionMat) snExplosionMat.uniforms.uT.value = localT;

      // エネルギー雲スタート
      if (snEnergyCloud && !snEnergyCloud.visible) snEnergyCloud.visible = true;
      if (snEnergyMat) snEnergyMat.uniforms.uT.value = localT;

      // 衝撃波拡大開始
      for (const sw of snShockwaves) {
        const swT = Math.max(0, localT - sw.delay);
        sw.mesh.scale.setScalar(0.5 + swT * sw.speed);
        sw.mat.uniforms.uOpacity.value = Math.max(0, 1 - swT * 2);
      }
      return;
    }
    // フェーズ C: 拡散
    if (t < SN_EXPAND_END) {
      const localT = t - SN_WARN_END;
      // 爆発粒子: 経過時間で位置進行 (シェーダ内で velocity * uT)
      if (snExplosionMat) snExplosionMat.uniforms.uT.value = localT;
      // 衝撃波: 拡大しつつフェード
      for (const sw of snShockwaves) {
        const swT = Math.max(0, localT - sw.delay);
        sw.mesh.scale.setScalar(0.5 + swT * sw.speed);
        sw.mat.uniforms.uOpacity.value = Math.max(0, 1 - swT * 0.4);
      }
      // エネルギー雲拡大
      if (snEnergyMat) snEnergyMat.uniforms.uT.value = localT;
      if (snEnergyCloud) snEnergyCloud.scale.setScalar(0.8 + localT * 2.0);
      // 閃光フェード
      if (snFlashSprite) snFlashSprite.material.opacity = Math.max(0, snFlashSprite.material.opacity * 0.92);
      // 恒星本体は完全に隠す
      if (starMesh) starMesh.scale.setScalar(0.001);
      for (const L of coronaLayers) L.mesh.scale.setScalar(0.001);
      _camShake = Math.max(0, 0.05 * (1 - (t - SN_FLASH_END) / 1.5));

      // 残骸星雲: 拡散後半で出現
      const expandFrac = (t - SN_FLASH_END) / (SN_EXPAND_END - SN_FLASH_END);
      if (expandFrac > 0.5 && snNebulaPoints && !snNebulaPoints.visible) {
        snNebulaPoints.visible = true;
      }
      if (snNebulaMat) {
        snNebulaMat.uniforms.uT.value    = (t - SN_FLASH_END) - 1.5;
        snNebulaMat.uniforms.uDecay.value = 0; // まだ濃い
      }
      return;
    }
    // フェーズ D: 残骸 (星雲漂う・減衰)
    if (t < SN_TOTAL) {
      const localT = t - SN_EXPAND_END;
      const fade = localT / (SN_TOTAL - SN_EXPAND_END); // 0..1
      if (snNebulaMat) {
        snNebulaMat.uniforms.uT.value     = t - SN_FLASH_END;
        snNebulaMat.uniforms.uDecay.value = fade;
      }
      // 既存要素は片付け
      if (snExplosionPoints) snExplosionPoints.visible = false;
      if (snEnergyCloud)     snEnergyCloud.visible = false;
      for (const sw of snShockwaves) sw.mesh.visible = false;
      if (snFlashSprite)     snFlashSprite.material.opacity = 0;
      _camShake = 0;
      return;
    }
    // 終了: リセット
    supernovaT = 0;
    _camShake = 0;
    if (sunMat) sunMat.uniforms.uInstability.value = 0;
    if (snFlashSprite)    { snFlashSprite.visible = false; snFlashSprite.material.opacity = 0; }
    for (const sw of snShockwaves) sw.mesh.visible = false;
    if (snExplosionPoints) snExplosionPoints.visible = false;
    if (snEnergyCloud)     snEnergyCloud.visible = false;
    if (snNebulaPoints)    snNebulaPoints.visible = false;
    // 恒星を通常スケールへ戻す
    if (starMesh) starMesh.scale.setScalar(cur.radius);
    for (const L of coronaLayers) L.mesh.scale.setScalar(cur.radius);
  }

  return { init, update, setPlanets, triggerSupernova };
})();
