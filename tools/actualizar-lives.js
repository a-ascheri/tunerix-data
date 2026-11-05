const fs = require('fs');
const https = require('https');

// La API Key se lee de forma segura desde los secretos de GitHub
const API_KEY = process.env.YT_API_KEY;

// ⚠️ IMPORTANTE: Reemplazá estos textos por los channelId reales (empiezan con UC...)
// Por ahora los dejo como ejemplo, si no los tenés, el script va a fallar pero no va a romper nada.
const CANALES = {
    tn: 'UC...ID_DE_TN',
    luzu: 'UC...ID_DE_LUZU'
};

function obtenerLive(channelId) {
    return new Promise((resolve) => {
        // Usamos search.list que es el único que devuelve si está en vivo
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${API_KEY}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        console.error(`Error de API (${json.error.code}):`, json.error.message);
                        resolve(null); // Si falla la cuota o el ID, devuelve null
                        return;
                    }
                    if (json.items && json.items.length > 0) {
                        // Agarramos el videoId del primer resultado
                        resolve(json.items[0].id.videoId);
                    } else {
                        resolve(null); // No hay live ahora
                    }
                } catch (e) {
                    console.error('Error parseando respuesta:', e.message);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            console.error('Error de red:', e.message);
            resolve(null);
        });
    });
}

(async () => {
    console.log('Iniciando consulta de lives...');
    const resultado = {};
    
    for (const [nombre, id] of Object.entries(CANALES)) {
        if (id.includes('UC...')) {
            console.log(`Saltando ${nombre}: Falta configurar el channelId real.`);
            continue;
        }
        console.log(`Consultando live de ${nombre}...`);
        resultado[nombre] = await obtenerLive(id);
    }

    // Guardamos solo los que tienen live activo
    const livesActivos = {};
    for (const [k, v] of Object.entries(resultado)) {
        if (v) livesActivos[k] = v;
    }
    
    fs.writeFileSync('lives.json', JSON.stringify(livesActivos, null, 2));
    console.log('Archivo lives.json actualizado:', livesActivos);
})();
