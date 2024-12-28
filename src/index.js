require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const EnhancedRouteService = require('./services/enhancedRouteService');

// Verificación mejorada de variables de entorno
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'MONGO_USER', 'MONGO_PASSWORD', 'HERE_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ Error: Variables de entorno faltantes:', missingVars.join(', '));
    process.exit(1);
}

// Construcción segura de MongoDB URI
const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@cluster0.jbyof.mongodb.net/tollboothdb?retryWrites=true&w=majority`;

// Inicialización del bot y servicio de rutas
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const routeService = new EnhancedRouteService();

// Función para validar coordenadas
const validateCoordinates = (coord) => {
    const pattern = /^-?\d+\.?\d*,-?\d+\.?\d*$/;
    if (!pattern.test(coord)) return false;
    
    const [lat, lon] = coord.split(',').map(Number);
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
};

// Función para formatear mensaje de casetas
const formatTollboothMessage = (caseta) => {
    return `- ${caseta.nombre}\n` +
           `  📍 ${caseta.carretera.tramo}\n` +
           `  📍 Coordenadas: ${caseta.coordenadas}\n` +
           `  💵 Auto: $${caseta.costo.auto}\n` +
           `  🚛 Camión: $${caseta.costo.camion}\n` +
           `  🚌 Autobús: $${caseta.costo.autobus}\n` +
           `  🌐 ${caseta.googleMapsUrl}`;
};

// Inicialización del bot
const iniciarBot = async () => {
    try {
        // Conexión a MongoDB con retry
        const connectWithRetry = async (retries = 5, delay = 5000) => {
            for (let i = 0; i < retries; i++) {
                try {
                    await mongoose.connect(MONGO_URI, {
                        serverSelectionTimeoutMS: 5000,
                        socketTimeoutMS: 45000,
                    });
                    console.log('✅ Conectado a MongoDB');
                    return;
                } catch (error) {
                    if (i === retries - 1) throw error;
                    console.log(`Intento ${i + 1} fallido, reintentando en ${delay/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        };

        await connectWithRetry();

        // Configurar comandos del bot
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Iniciar el bot' },
            { command: 'route', description: 'Calcular ruta y costos de casetas' },
            { command: 'help', description: 'Mostrar ayuda' }
        ]);

        // Comando start
        bot.command('start', async (ctx) => {
            try {
                await ctx.reply(
                    '¡Bienvenido al Bot de Casetas! 🛣\n\n' +
                    'Este bot te ayuda a calcular los costos de casetas en tu ruta.\n\n' +
                    'Usa el comando /route seguido de:\n' +
                    '1️⃣ Coordenadas de origen (latitud,longitud)\n' +
                    '2️⃣ Coordenadas de destino (latitud,longitud)\n\n' +
                    'Ejemplo:\n' +
                    '/route 19.4789,-99.1325 20.5881,-100.3889\n\n' +
                    'Usa /help para más información.'
                );
            } catch (error) {
                console.error('Error en comando start:', error);
                await ctx.reply('❌ Error al iniciar el bot. Por favor, intenta nuevamente.');
            }
        });

        // Comando help
        bot.command('help', async (ctx) => {
            await ctx.reply(
                '📖 Ayuda del Bot de Casetas\n\n' +
                '🔍 Cómo usar el bot:\n\n' +
                '1. Formato del comando:\n' +
                '/route origen destino\n\n' +
                '2. Coordenadas:\n' +
                '- Usar formato decimal: latitud,longitud\n' +
                '- Ejemplo: 19.4789,-99.1325\n\n' +
                '3. Ejemplo completo:\n' +
                '/route 19.4789,-99.1325 20.5881,-100.3889'
            );
        });

        // Comando route
        bot.command('route', async (ctx) => {
            try {
                const text = ctx.message.text;
                const parts = text.trim().split(/\s+/);
        
                if (parts.length < 3 || parts.length > 4) {
                    return ctx.reply(
                        '❓ Formato incorrecto.\n\n' +
                        'Uso correcto: /route origen destino [tipo]\n' +
                        'Ejemplo: /route 19.4789,-99.1325 20.5881,-100.3889 auto\n\n' +
                        'Tipos de vehículo disponibles:\n' +
                        '🚗 auto (predeterminado)\n' +
                        '🚛 camion\n' +
                        '🚌 autobus\n\n' +
                        'Para más ayuda, usa /help'
                    );
                }
        
                const [_, origen, destino, tipoVehiculo = 'auto'] = parts;
        
                // Validar tipo de vehículo
                if (tipoVehiculo && !['auto', 'camion', 'autobus'].includes(tipoVehiculo.toLowerCase())) {
                    return ctx.reply(
                        '❌ Tipo de vehículo no válido.\n' +
                        'Tipos disponibles: auto, camion, autobus\n' +
                        'Si no especificas, se usa "auto" por defecto.'
                    );
                }
        
                if (!validateCoordinates(origen) || !validateCoordinates(destino)) {
                    return ctx.reply(
                        '❌ Formato de coordenadas incorrecto.\n' +
                        'Debe ser: latitud,longitud\n' +
                        'Ejemplo: 19.4789,-99.1325'
                    );
                }
        
                const [originLat, originLon] = origen.split(',').map(Number);
                const [destLat, destLon] = destino.split(',').map(Number);
        
                const processingMsg = await ctx.reply('🔄 Calculando ruta y costos...');
        
                const result = await routeService.calculateRoute(originLat, originLon, destLat, destLon, tipoVehiculo);
        
                // Obtener el emoji correspondiente al tipo de vehículo
                const vehicleEmoji = {
                    auto: '🚗',
                    camion: '🚛',
                    autobus: '🚌'
                }[tipoVehiculo.toLowerCase()];
        
                // Construcción del mensaje de respuesta
                let message = `🛣 Ruta calculada para ${vehicleEmoji} ${tipoVehiculo}:\n\n`;
                message += `📍 Origen: ${origen}\n`;
                message += `🏁 Destino: ${destino}\n`;
                message += `📏 Distancia: ${result.distancia.toFixed(1)} km\n`;
                message += `⏱ Tiempo estimado: ${result.tiempo} min\n`;
                message += `💰 Costo total: $${result.costoTotal.toFixed(2)} MXN\n\n`;
        
                if (result.casetas.length > 0) {
                    message += '🚧 Casetas en la ruta:\n\n';
                    message += result.casetas.map(caseta => 
                        `- ${caseta.nombre}\n` +
                        `  📍 ${caseta.carretera.tramo}\n` +
                        `  📍 Coordenadas: ${caseta.coordenadas}\n` +
                        `  💰 Costo: $${caseta.costo[tipoVehiculo.toLowerCase()]}\n` +
                        `  🌐 Ver en Maps: https://www.google.com/maps?q=${caseta.coordenadas}`
                    ).join('\n\n');
                } else {
                    message += '✨ No se encontraron casetas en la ruta.';
                }
        
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                await ctx.reply(message);
        
                // Logs de sistema
                console.log('\n📊 DATOS DE LA RUTA CALCULADA');
                console.log('============================');
                console.log(`Tipo de vehículo: ${tipoVehiculo}`);
                console.log(`Origen: ${origen}`);
                console.log(`Destino: ${destino}`);
                console.log(`Distancia: ${result.distancia.toFixed(1)} km`);
                console.log(`Tiempo: ${result.tiempo} min`);
                console.log(`Costo Total: $${result.costoTotal.toFixed(2)} MXN`);
        
                if (result.casetas.length > 0) {
                    console.log('\n🚧 CASETAS DETECTADAS');
                    console.log('===================');
                    result.casetas.forEach((caseta, index) => {
                        console.log(`\nCaseta ${index + 1}: ${caseta.nombre}`);
                        console.log(`Tramo: ${caseta.carretera.tramo}`);
                        console.log(`Coordenadas: ${caseta.coordenadas}`);
                        console.log(`Costo ${tipoVehiculo}: $${caseta.costo[tipoVehiculo.toLowerCase()]}`);
                    });
                }
        
                console.log('\n📝 RESUMEN');
                console.log('=========');
                console.log(`Total casetas: ${result.casetas.length}`);
                console.log(`Costo total: $${result.costoTotal} MXN`);
                console.log(`Distancia promedio entre casetas: ${(result.distancia / (result.casetas.length || 1)).toFixed(1)} km`);
        
            } catch (error) {
                console.error('Error en comando route:', error);
                await ctx.reply(
                    '❌ Error al procesar la ruta.\n' +
                    'Por favor verifica los datos e intenta nuevamente.\n' +
                    'Si el error persiste, usa /help para más información.'
                );
            }
        });

        // Manejar mensajes no reconocidos
        bot.on('message', (ctx) => {
            ctx.reply(
                '❓ Comando no reconocido.\n\n' +
                'Para calcular una ruta, usa el comando /route.\n' +
                'Para ver la ayuda, usa /help\n\n' +
                'Ejemplo:\n' +
                '/route 19.4789,-99.1325 20.5881,-100.3889'
            );
        });

        // Iniciar el bot
        await bot.launch();
        console.log('✅ Bot iniciado correctamente');

    } catch (error) {
        console.error('❌ Error de inicialización:', error);
        process.exit(1);
    }
};

// Manejo mejorado de señales de terminación
const shutdown = async (signal) => {
    console.log(`\n${signal} recibido. Cerrando aplicación...`);
    try {
        await bot.stop(signal);
        await mongoose.connection.close();
        console.log('✅ Conexiones cerradas correctamente');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error durante el cierre:', error);
        process.exit(1);
    }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Manejo de errores no capturados
process.on('unhandledRejection', (error) => {
    console.error('❌ Error no manejado:', error);
});

// Iniciar el bot
iniciarBot().catch(console.error);