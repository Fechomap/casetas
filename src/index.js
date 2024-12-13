// src/index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const RouteService = require('./services/routeService');

// Verificar variables de entorno críticas
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'MONGO_USER', 'MONGO_PASSWORD', 'HERE_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Error: ${envVar} no está definida en las variables de entorno`);
        process.exit(1);
    }
}

// Construir MongoDB URI de forma segura
const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@cluster0.jbyof.mongodb.net/tollboothdb?retryWrites=true&w=majority`;

// Inicializar el bot y el servicio de rutas
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const routeService = new RouteService();

// Función asíncrona para iniciar el bot
const iniciarBot = async () => {
    try {
        // Conectar a MongoDB con manejo de errores
        await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('✅ Conectado a MongoDB');

        // Configurar comandos del bot
        await bot.telegram.setMyCommands([
            { command: 'start', description: 'Iniciar el bot' },
            { command: 'route', description: 'Calcular ruta y costos de casetas' }
        ]);

        // Comando start
        bot.command('start', async (ctx) => {
            try {
                await ctx.reply(
                    '¡Bienvenido al Bot de Casetas! 🛣\n\n' +
                    'Usa el comando /route seguido de:\n' +
                    '- Coordenadas de origen (lat,lon)\n' +
                    '- Coordenadas de destino (lat,lon)\n' +
                    '- Sentido de la ruta (N-S, S-N, E-O, O-E)\n\n' +
                    'Ejemplo:\n' +
                    '/route 19.4789,-99.1325 20.5881,-100.3889 N-S'
                );
            } catch (error) {
                console.error('Error en comando start:', error);
                await ctx.reply('❌ Error al iniciar el bot. Por favor, intenta nuevamente.');
            }
        });

        // Comando route con validaciones mejoradas
        bot.command('route', async (ctx) => {
            try {
                const text = ctx.message.text;
                const parts = text.trim().split(/\s+/);

                if (parts.length !== 4) {
                    return ctx.reply(
                        '❌ Formato incorrecto. Uso correcto:\n' +
                        '/route origen_lat,origen_lon destino_lat,destino_lon sentido\n\n' +
                        'Ejemplo:\n' +
                        '/route 19.4789,-99.1325 20.5881,-100.3889 N-S'
                    );
                }

                const [_, origen, destino, sentido] = parts;
                const sentidosValidos = ['N-S', 'S-N', 'E-O', 'O-E'];
                
                if (!sentidosValidos.includes(sentido)) {
                    return ctx.reply('❌ Sentido inválido. Debe ser: N-S, S-N, E-O, o O-E');
                }

                const coordPattern = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
                if (!coordPattern.test(origen) || !coordPattern.test(destino)) {
                    return ctx.reply('❌ Formato de coordenadas incorrecto. Usa: latitud,longitud');
                }

                const [originLat, originLon] = origen.split(',').map(Number);
                const [destLat, destLon] = destino.split(',').map(Number);

                // Enviar mensaje de procesamiento
                const processingMsg = await ctx.reply('🔄 Calculando ruta y costos...');

                const result = await routeService.calculateRoute(originLat, originLon, destLat, destLon, sentido);
                
                // Construir mensaje de respuesta
                let message = `🛣 Ruta calculada:\n\n`;
                message += `📍 Origen: ${origen}\n`;
                message += `🏁 Destino: ${destino}\n`;
                message += `↔️ Sentido: ${sentido}\n\n`;
                message += `📏 Distancia: ${result.distancia.toFixed(1)} km\n`;
                message += `⏱ Tiempo estimado: ${result.tiempo} min\n`;
                message += `💰 Costo total: $${result.costoTotal.toFixed(2)}\n\n`;

                if (result.casetas.length > 0) {
                    message += '🚧 Casetas en la ruta:\n\n';
                    message += result.casetas.map(caseta => 
                        `- ${caseta.nombre}\n` +
                        `  📍 ${caseta.carretera.tramo}\n` +
                        `  💵 Auto: $${caseta.costo.auto}\n` +
                        `  🚛 Camión: $${caseta.costo.camion}\n` +
                        `  🚌 Autobús: $${caseta.costo.autobus}`
                    ).join('\n\n');
                } else {
                    message += '✨ No se encontraron casetas en la ruta.';
                }

                // Eliminar mensaje de procesamiento y enviar resultado
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                await ctx.reply(message);

            } catch (error) {
                console.error('Error en comando route:', error);
                await ctx.reply('❌ Error al procesar la ruta. Por favor, verifica los datos e intenta nuevamente.');
            }
        });

        // Manejar mensajes no reconocidos
        bot.on('message', (ctx) => {
            ctx.reply('❓ Para calcular una ruta, usa el comando /route.\n\nEjemplo:\n/route 19.4789,-99.1325 20.5881,-100.3889 N-S');
        });

        // Iniciar el bot
        await bot.launch();
        console.log('✅ Bot iniciado correctamente');

    } catch (error) {
        console.error('❌ Error de inicialización:', error);
        process.exit(1);
    }
};

// Manejo de señales de terminación
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    mongoose.connection.close();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    mongoose.connection.close();
});

// Iniciar el bot
iniciarBot().catch(console.error);