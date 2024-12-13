// src/services/enhancedRouteService.js
const axios = require('axios');
const mongoose = require('mongoose');
const { decode } = require('@here/flexpolyline');
const pLimit = require('p-limit');
const pRetry = require('p-retry');
const NodeCache = require('node-cache');
const TollBooth = require('../models/TollBooth');

class EnhancedRouteService {
    constructor() {
        if (!process.env.HERE_API_KEY) {
            throw new Error('HERE_API_KEY no está configurada');
        }
        this.hereApiKey = process.env.HERE_API_KEY;
        this.limit = pLimit(3);
        this.cache = new NodeCache({ 
            stdTTL: 3600,
            checkperiod: 600,
            useClones: false
        });
        
        // Configuración de validación de ruta
        this.routeConfig = {
            shortRouteThreshold: 30,
            initialSearchRadius: 5000,
            maxSearchRadius: 10000,
            minTollboothDistance: 1000,
            routeBufferDistance: 1000,
            sampleRateShort: 5,
            sampleRateLong: 50
        };
    }

    calculateBearing(lat1, lon1, lat2, lon2) {
        const toRad = n => n * Math.PI / 180;
        const φ1 = toRad(lat1);
        const φ2 = toRad(lat2);
        const Δλ = toRad(lon2 - lon1);

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) -
                 Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // Añadir después del método calculateBearing y antes de validateSentido:

    calculateRouteBearing(coordinates) {
    if (coordinates.length < 2) return null;
    
    // Tomar varios puntos de la ruta para un cálculo más preciso
    const numPoints = Math.min(5, coordinates.length);
    const step = Math.floor(coordinates.length / numPoints);
    let totalBearing = 0;
    let count = 0;

    for (let i = 0; i < coordinates.length - step; i += step) {
        const [lon1, lat1] = coordinates[i];
        const [lon2, lat2] = coordinates[i + step];
        totalBearing += this.calculateBearing(lat1, lon1, lat2, lon2);
        count++;
    }

    const avgBearing = totalBearing / count;
    console.log(`Bearing promedio de la ruta: ${avgBearing.toFixed(1)}°`);
    return avgBearing;
    }

    validateSentido(bearing, sentido) {
        const sentidoRanges = {
            'N-S': [[135, 225]],
            'S-N': [[315, 360], [0, 45]],
            'E-O': [[225, 315]],
            'O-E': [[45, 135]]
        };

        const ranges = sentidoRanges[sentido];
        return ranges.some(([min, max]) => {
            if (min > max) {
                return bearing >= min || bearing <= max;
            }
            return bearing >= min && bearing <= max;
        });
    }

    async findOptimalSearchRadius(lon, lat) {
        let radius = this.routeConfig.initialSearchRadius;
        let casetas = [];
        
        while (radius <= this.routeConfig.maxSearchRadius) {
            casetas = await TollBooth.findNearby(lon, lat, radius);
            if (casetas.length >= 2) break;
            radius += 2500;
        }

        return radius;
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Radio de la Tierra en metros
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                 Math.cos(φ1) * Math.cos(φ2) *
                 Math.sin(Δλ/2) * Math.sin(Δλ/2);
        
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    async findTollboothsInRoute(coordinates) {
        const startTime = Date.now();
        try {
            const uniqueCasetas = new Map();
            const routeBearing = this.calculateRouteBearing(coordinates);
            console.log(`Bearing calculado de la ruta: ${routeBearing.toFixed(1)}°`);

            // Calcular distancia total de la ruta
            const routeDistance = this.calculateDistanceAlongRoute(coordinates) / 1000;
            console.log(`Distancia de ruta: ${routeDistance.toFixed(2)} km`);

            // Ajustar tasa de muestreo basado en la distancia
            const sampleRate = routeDistance < this.routeConfig.shortRouteThreshold ? 
                this.routeConfig.sampleRateShort : 
                this.routeConfig.sampleRateLong;

            // Optimizar puntos de muestreo
            const sampledCoordinates = [];
            for (let i = 0; i < coordinates.length; i += sampleRate) {
                sampledCoordinates.push(coordinates[i]);
            }
            // Asegurar que incluimos el último punto
            if (sampledCoordinates[sampledCoordinates.length - 1] !== coordinates[coordinates.length - 1]) {
                sampledCoordinates.push(coordinates[coordinates.length - 1]);
            }

            console.log(`Puntos de muestreo: ${sampledCoordinates.length}`);

            // Dividir en chunks para procesar por lotes
            const chunkSize = 10;
            for (let i = 0; i < sampledCoordinates.length; i += chunkSize) {
                const chunk = sampledCoordinates.slice(i, i + chunkSize);
                
                await Promise.all(chunk.map(([lon, lat]) => 
                    this.limit(async () => {
                        try {
                            const casetas = await TollBooth.findNearby(
                                lon, 
                                lat, 
                                this.routeConfig.initialSearchRadius
                            );

                            for (const caseta of casetas) {
                                if (!uniqueCasetas.has(caseta._id.toString())) {
                                    const [casetaLon, casetaLat] = caseta.ubicacion.coordinates;
                                    const distance = this.haversineDistance(
                                        lat, lon, casetaLat, casetaLon
                                    );

                                    if (distance <= this.routeConfig.routeBufferDistance) {
                                        console.log(`Caseta encontrada: ${caseta.nombre} a ${distance.toFixed(0)}m`);
                                        uniqueCasetas.set(caseta._id.toString(), {
                                            ...caseta.toObject(),
                                            distanceOnRoute: this.calculateDistanceAlongRoute(
                                                coordinates.slice(0, coordinates.indexOf([lon, lat]) + 1)
                                            )
                                        });
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('Error en findTollboothsInRoute:', error);
                            return [];
                        }
                    })
                ));

                // Agregar pequeña pausa entre chunks para evitar sobrecarga
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const timeElapsed = Date.now() - startTime;
            console.log(`Búsqueda completada en: ${timeElapsed}ms`);

            // Ordenar y filtrar resultados
            const casetasOrdenadas = Array.from(uniqueCasetas.values())
                .sort((a, b) => a.distanceOnRoute - b.distanceOnRoute)
                .filter((caseta, index, array) => {
                    if (index === 0) return true;
                    const prevCaseta = array[index - 1];
                    return this.haversineDistance(
                        caseta.ubicacion.coordinates[1],
                        caseta.ubicacion.coordinates[0],
                        prevCaseta.ubicacion.coordinates[1],
                        prevCaseta.ubicacion.coordinates[0]
                    ) >= this.routeConfig.minTollboothDistance;
                });

                
            console.log(`Casetas encontradas y filtradas: ${casetasOrdenadas.length}`);
            return casetasOrdenadas;

            

        } catch (error) {
            console.error('Error en findTollboothsInRoute:', error);
            return [];
        }
    }

    calculateDistanceAlongRoute(coordinates) {
        let distance = 0;
        for (let i = 0; i < coordinates.length - 1; i++) {
            distance += this.haversineDistance(
                coordinates[i][1], coordinates[i][0],
                coordinates[i + 1][1], coordinates[i + 1][0]
            );
        }
        return distance;
    }

    async calculateRoute(originLat, originLon, destLat, destLon) {
        const cacheKey = `route_${originLat}_${originLon}_${destLat}_${destLon}`;
        const cachedResult = this.cache.get(cacheKey);
        
        if (cachedResult) {
            console.log('Retornando resultado desde cache');
            return cachedResult;
        }

        try {
            console.log(`Calculando ruta: ${originLat},${originLon} -> ${destLat},${destLon}`);
            
            const routeResponse = await this.getHereRoute(originLat, originLon, destLat, destLon);
            if (!routeResponse || !routeResponse.route) {
                throw new Error('No se pudo obtener la ruta desde HERE Maps');
            }

            const encodedPolyline = routeResponse.route.sections[0].polyline;
            const decoded = decode(encodedPolyline);
            const coordinates = decoded.polyline.map(([lat, lon]) => [lon, lat]);

            const casetas = await this.findTollboothsInRoute(coordinates);
            console.log(`Casetas encontradas: ${casetas.length}`);

            const result = {
                distancia: routeResponse.distance,
                tiempo: routeResponse.duration,
                casetas: casetas,
                costoTotal: this.calculateTotalCost(casetas)
            };

            this.cache.set(cacheKey, result);
            return result;

        } catch (error) {
            console.error('Error en calculateRoute:', error);
            throw new Error(`Error al calcular la ruta: ${error.message}`);
        }
    }

    // Métodos heredados del servicio original
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
                    timeout: 30000  // Reducido a 30 segundos
                }),
                {
                    retries: 3,
                    minTimeout: 1000,
                    maxTimeout: 5000,
                    onFailedAttempt: error => {
                        console.log(`Intento fallido al obtener ruta. Reintentando... Error: ${error.message}`);
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

    calculateTotalCost(casetas, vehicleType = 'auto') {
        return casetas.reduce((total, caseta) => {
            const costo = caseta.costo && caseta.costo[vehicleType] ? 
                         caseta.costo[vehicleType] : 0;
            return total + costo;
        }, 0);
    }
}

module.exports = EnhancedRouteService;