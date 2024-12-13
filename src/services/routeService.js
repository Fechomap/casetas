// src/services/routeService.js
const axios = require('axios');
const mongoose = require('mongoose');
const { decode } = require('@here/flexpolyline');
const pLimit = require('p-limit');
const pRetry = require('p-retry');
const NodeCache = require('node-cache');
const TollBooth = require('../models/TollBooth');

class RouteService {
    constructor() {
        if (!process.env.HERE_API_KEY) {
            throw new Error('HERE_API_KEY no está configurada en las variables de entorno');
        }
        this.hereApiKey = process.env.HERE_API_KEY;
        this.limit = pLimit(5);
        this.cache = new NodeCache({ 
            stdTTL: 3600,
            checkperiod: 600,
            useClones: false
        });
    }

    validateCoordinates(originLat, originLon, destLat, destLon) {
        const coords = [
            { lat: originLat, lon: originLon, name: 'origen' },
            { lat: destLat, lon: destLon, name: 'destino' }
        ];

        for (const coord of coords) {
            if (!this.isValidLatitude(coord.lat)) {
                throw new Error(`Latitud inválida para ${coord.name}: ${coord.lat}`);
            }
            if (!this.isValidLongitude(coord.lon)) {
                throw new Error(`Longitud inválida para ${coord.name}: ${coord.lon}`);
            }
        }
    }

    isValidLatitude(lat) {
        return !isNaN(lat) && lat >= -90 && lat <= 90;
    }

    isValidLongitude(lon) {
        return !isNaN(lon) && lon >= -180 && lon <= 180;
    }

    toPlainObject(doc) {
        if (!doc) return null;
        if (Array.isArray(doc)) {
            return doc.map(item => item.toObject ? item.toObject() : item);
        }
        return doc.toObject ? doc.toObject() : doc;
    }

    async calculateRoute(originLat, originLon, destLat, destLon, sentido) {
        const cacheKey = `route_${originLat}_${originLon}_${destLat}_${destLon}_${sentido}`;
        const cachedResult = this.cache.get(cacheKey);
        
        if (cachedResult) {
            console.log('Retornando resultado desde cache');
            return cachedResult;
        }

        try {
            console.log('Iniciando cálculo de ruta...');
            console.log(`Origen: ${originLat},${originLon}`);
            console.log(`Destino: ${destLat},${destLon}`);
            console.log(`Sentido: ${sentido}`);
            
            this.validateCoordinates(originLat, originLon, destLat, destLon);

            const routeResponse = await this.getHereRoute(originLat, originLon, destLat, destLon);
            
            if (!routeResponse || !routeResponse.route) {
                throw new Error('No se pudo obtener la ruta desde HERE Maps');
            }

            const casetas = await this.findTollboothsInRoute(routeResponse.route);
            console.log(`Casetas encontradas: ${casetas.length}`);
            
            const casetasFiltradas = this.filterAndSortTollbooths(casetas, sentido);
            console.log(`Casetas filtradas por sentido ${sentido}: ${casetasFiltradas.length}`);

            const casetasPlanas = this.toPlainObject(casetasFiltradas);
            const costoTotal = this.calculateTotalCost(casetasPlanas);

            const result = {
                distancia: routeResponse.distance,
                tiempo: routeResponse.duration,
                casetas: casetasPlanas,
                costoTotal: costoTotal
            };

            this.cache.set(cacheKey, result);
            return result;

        } catch (error) {
            console.error('Error en calculateRoute:', error);
            throw new Error(`Error al calcular la ruta: ${error.message}`);
        }
    }

    async getHereRoute(originLat, originLon, destLat, destLon) {
        try {
            const url = 'https://router.hereapi.com/v8/routes';
            const response = await pRetry(
                () => axios.get(url, {
                    params: {
                        apiKey: this.hereApiKey,
                        transportMode: 'car',
                        origin: `${originLat},${originLon}`,
                        destination: `${destLat},${destLon}`,
                        return: 'polyline,summary',
                        alternatives: 0,
                        units: 'metric'
                    },
                    timeout: 15000
                }),
                {
                    retries: 3,
                    onFailedAttempt: error => {
                        console.log(`Intento fallido al obtener ruta. Error: ${error.message}`);
                    }
                }
            );

            if (!response.data.routes || !response.data.routes[0]) {
                throw new Error('Respuesta inválida de HERE Maps');
            }

            const route = response.data.routes[0];
            return {
                route: route,
                distance: route.sections[0].summary.length / 1000,
                duration: Math.round(route.sections[0].summary.duration / 60)
            };

        } catch (error) {
            console.error('Error en getHereRoute:', error);
            throw new Error(`Error al obtener la ruta: ${error.message}`);
        }
    }

    async findTollboothsInRoute(route) {
        try {
            const encodedPolyline = route.sections[0].polyline;
            const decoded = decode(encodedPolyline);
            const coordinates = decoded.polyline.map(([lat, lon]) => [lon, lat]);

            const sampleRate = Math.max(1, Math.floor(coordinates.length / 50));
            const sampledCoordinates = coordinates.filter((_, index) => index % sampleRate === 0);

            const uniqueCasetas = new Map();
            
            await Promise.all(
                sampledCoordinates.map(([lon, lat]) => 
                    this.limit(async () => {
                        try {
                            const casetas = await TollBooth.find({
                                ubicacion: {
                                    $near: {
                                        $geometry: {
                                            type: 'Point',
                                            coordinates: [lon, lat]
                                        },
                                        $maxDistance: 10000
                                    }
                                }
                            }).lean().exec();

                            casetas.forEach(caseta => {
                                if (!uniqueCasetas.has(caseta._id.toString())) {
                                    uniqueCasetas.set(caseta._id.toString(), caseta);
                                }
                            });

                        } catch (error) {
                            console.error(`Error al buscar casetas cerca de ${lat},${lon}:`, error);
                        }
                    })
                )
            );

            return Array.from(uniqueCasetas.values());

        } catch (error) {
            console.error('Error en findTollboothsInRoute:', error);
            return [];
        }
    }

    filterAndSortTollbooths(casetas, sentido) {
        return casetas
            .filter(caseta => caseta.sentido === sentido)
            .sort((a, b) => {
                if (a.distancia && b.distancia) {
                    return a.distancia - b.distancia;
                }
                return 0;
            });
    }

    calculateTotalCost(casetas, vehicleType = 'auto') {
        return casetas.reduce((total, caseta) => {
            const costo = caseta.costo && caseta.costo[vehicleType] ? 
                         caseta.costo[vehicleType] : 0;
            return total + costo;
        }, 0);
    }
}

module.exports = RouteService;