// ============================================================
// actualizar-lives.js — detecta el EN VIVO de cada canal de YouTube
// y lo publica en lives.json para que la app Tunerix lo consuma.
//
// Cómo funciona (a prueba de cambios de cuota):
//   1. Scrape de la página youtube.com/@CANAL/live → saca los videoId
//      candidatos. Cuesta 0 unidades de cuota.
//   2. videos.list (1 unidad) valida cuál está realmente "live",
//      embeddable y público. Suficiente con una llamada para todos
//      los candidatos del canal.
//   3. Plan B (solo si el scrape falla): search.list eventType=live
//      (100 unidades). Al ser el recurso raro, el uso diario queda
//      alrededor de 1 unidad por canal y corrida.
//
// Corre en GitHub Actions cada 20 min (ver .github/workflows/).
// Nunca lanza errores: si algo falla, el canal simplemente no se
// publica en lives.json y la app esa hora sigue con el videoId viejo.
//
//  Formato de la app: lives.json = { "tn": "videoId11", "luzu": "…" }
//  (las claves son los `id` de las estaciones TV en stations.json)
// ============================================================
const fs = require('fs');
const https = require('https');

const API_KEY = process.env.YT_API_KEY || '';

// handle de YouTube  →  id de la estación en stations.json
const CANALES = {
    todonoticias: 'tn',      // TN
    luzutv: 'luzu',          // Luzu TV
    elnueve: 'canal9',       // El Nueve
    A24com: 'a24',           // A24
    c5n: 'c5n',              // C5N
    canal26: 'canal26',      // Canal 26 (4K)
    telefenoticias: 'telefe',    // Telefe (Telefe Noticias)
    eltrece: 'canaltrece',   // Canal Trece
    cronicatv: 'cronica',    // Crónica TV
    lanacion: 'lnp',         // LN+
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VID = /^[A-Za-z0-9_-]{11}$/;

// channelIds reales (verificados con la API): solo para el plan B con search
const BUSCAR_ID = {
    todonoticias: 'UCj6PcyLvpnIRT_2W_mwa9Aw',
    luzutv: 'UCTHaNTsP7hsVgBxARZTuajw',
    elnueve: 'UCUT4NmGqjrVpKf2JyiS_bbA',
    A24com: 'UCR9120YBAqMfntqgRTKmkjQ',
    c5n: 'UCFgk2Q2mVO1BklRQhSv6p0w',
    canal26: 'UCrpMfcQNog595v5gAS-oUsQ',
    telefenoticias: 'UChxGASjdNEYHhVKpl667Huw',
    // Canal Trece: la señal en vivo la publica @eltrevyecto (el UC0DM…); "El 13" UCd4D3… resultó
    // ser Canal 13 DE CHILE — no usar. El script solo actualiza cuando @eltrece esté al aire.
    eltrece: 'UC0DM_mHV2u6dj8ig51GkQwg',
    cronicatv: 'UCT7KFGv6s2a-rh2Jq8ZdM1g',
    lanacion: 'UCba3hpU7EFBSk817y9qZkiA',
};

const SEG = 5;                                  // margen para enviar respuestas grandes
function get(url, headers) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: Object.assign({ 'user-agent': UA }, headers || {}) }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(res.headers.location, headers));
            }
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: data }));
        }).on('error', reject).setTimeout(15000, function () { this.destroy(new Error('timeout')); });
    });
}
function apiGet(path) {
    return get('https://www.googleapis.com' + path + (path.includes('?') ? '&' : '?') + 'key=' + API_KEY)
        .then(r => JSON.parse(r.text));
}

// --- 1) candidatos de videoId del vivo del canal (0 unidades) ---
// Se apuesta por channel/UC…/live (los channelId son estables); el handle es respaldo,
// porque YouTube a veces da 404 en handles que estuvieron bien.
async function candidatos(handle) {
    const channelId = BUSCAR_ID[handle] || '';
    if (!channelId) throw new Error('sin channelId configurado');
    const urls = [
        'https://www.youtube.com/channel/' + channelId + '/live',
        'https://www.youtube.com/' + handle + '/live',
    ];
    for (const url of urls) {
        try {
            const r = await get(url);
            if (r.status !== 200) { console.error(url + ' → HTTP ' + r.status); continue; }
            const out = new Set();
            for (const m of r.text.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) out.add(m[1]);
            for (const m of r.text.matchAll(/[?&]v=([A-Za-z0-9_-]{11})/g)) out.add(m[1]);
            const list = [...out].slice(0, 15);        // sobran; videos.listacepta 50 por llamada
            if (!list.length) { console.error(url + ' no trajo candidatos'); continue; }
            return list;
        } catch (e) {
            console.error(url + ' falló: ' + e.message);
        }
    }
    throw new Error('ninguna vía de scrape funcionó');
}

// elige el primer candidato que esté EN VIVO, embebible, público y DEL canal esperado
function eleccion(items, channelIdEsperado) {
    for (const it of items || []) {
        if (it.snippet && it.snippet.liveBroadcastContent === 'live' &&
            it.status && it.status.embeddable && it.status.privacyStatus === 'public' &&
            (!channelIdEsperado || it.snippet.channelId === channelIdEsperado)) return it.id;
    }
    return null;
}

// --- 2) validación con videos.list (1 unidad) ---
async function validar(ids, channelIdEsperado) {
    const d = await apiGet('/youtube/v3/videos?part=snippet,status&id=' + ids.join(','));
    if (d.error) throw new Error('API ' + d.error.code + ': ' + d.error.message);
    return eleccion(d.items, channelIdEsperado);
}

// --- 3) plan B: search.list eventType=live (100 unidades, solo si el scrape falló) ---
async function searchLive(channelId) {
    const d = await apiGet('/youtube/v3/search?part=snippet&channelId=' + channelId + '&eventType=live&type=video&maxResults=5');
    if (d.error) { console.error('search falló ' + d.error.code + ': ' + d.error.message); return null; }
    if (!d.items || !d.items.length) return null;   // no hay live ahora
    const id = d.items[0].id && d.items[0].id.videoId;
    if (!id) return null;
    const v = await apiGet('/youtube/v3/videos?part=snippet,status&id=' + id);   // igual se valida
    const pick = eleccion(v.items, channelId);
    if (!pick) console.error('search devolvió ' + id + ' pero no es live publicable');
    return pick;
}

(async () => {
    console.log('Iniciando consulta de lives (' + new Date().toISOString() + ')…');
    if (!API_KEY) { console.error('Falta el secreto YT_API_KEY: no se publica nada'); }

    const lives = {};
    for (const [handle, idEstacion] of Object.entries(CANALES)) {
        try {
            let videoId = null;
            const cands = await candidatos(handle);
            if (cands.length) {
                console.log(handle + ': ' + cands.length + ' candidatos, validando…');
                videoId = await validar(cands, BUSCAR_ID[handle]);         // 1 unidad
                if (videoId) console.log(handle + ' → en vivo: ' + videoId);
            }
            // El plan B con search (100 un.) SOLO si el scrape falló. Si el scrape devolvió
            // candidatos y el canal no está al aire, esa es la respuesta: no gastar search.
            if (!videoId && !cands.length) {
                console.log(handle + ': scrape sin candidatos → plan B (search)');
                videoId = await searchLive(BUSCAR_ID[handle] || '');       // 0–100 unidades
                if (videoId) console.log(handle + ' → (por search) en vivo: ' + videoId);
            }
            if (videoId) lives[idEstacion] = videoId;
        } catch (e) {
            console.error(handle + ': ' + e.message);     // el canal queda sin publicar, sin romper nada
        }
    }

    fs.writeFileSync('lives.json', JSON.stringify(lives));
    console.log('lives.json publicado: ' + (Object.keys(lives).length ? Object.keys(lives).join(', ') : '(ningún canal al aire)'));
    // Rastro para debuggear en Actions: cuánto quedó en el JSON
    process.exit(0);   // por las dudas: nunca terminar "mal" (el commit decide el workflow)
})();
