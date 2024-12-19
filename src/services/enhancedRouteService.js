const axios = require('axios');
const mongoose = require('mongoose');
const { decode } = require('@here/flexpolyline');
const pLimit = require('p-limit');
const pRetry = require('p-retry');
const NodeCache = require('node-cache');
const TollBooth = require('../models/TollBooth');
const EARTH_RADIUS = 6371000;

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
        
        this.routeConfig = {
            shortRouteThreshold: 30,
            initialSearchRadius: 2000,
            maxSearchRadius: 5000,
            minTollboothDistance: 100,
            routeBufferDistance: 1000,
            sampleRateShort: 2,
            sampleRateLong: 10,
            mainRoadThreshold: 5, // Ahora sólo aceptamos casetas a menos de 5 metros
            tollBoothSideThreshold: 25
        };
    }

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                 Math.cos(φ1) * Math.cos(φ2) *
                 Math.sin(Δλ/2) * Math.sin(Δλ/2);
        
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    formatCoordinates(coord) {
        return `[${coord[0].toFixed(6)}, ${coord[1].toFixed(6)}]`;
    }

    calculatePerpendicularDistance(point, lineStart, lineEnd) {
        const [x, y] = point;
        const [x1, y1] = lineStart;
        const [x2, y2] = lineEnd;
        
        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) param = dot / lenSq;
        
        let xx, yy;
        
        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }
        
        const dx = x - xx;
        const dy = y - yy;
        
        return {
            distance: Math.sqrt(dx * dx + dy * dy) * 111000
        };
    }

    sampleCoordinates(coordinates, routeDistance) {
        const sampleRate = routeDistance < this.routeConfig.shortRouteThreshold ? 
            this.routeConfig.sampleRateShort : 
            this.routeConfig.sampleRateLong;

        const sampledCoordinates = [];
        for (let i = 0; i < coordinates.length; i += sampleRate) {
            sampledCoordinates.push(coordinates[i]);
        }
        
        if (sampledCoordinates[sampledCoordinates.length - 1] !== coordinates[coordinates.length - 1]) {
            sampledCoordinates.push(coordinates[coordinates.length - 1]);
        }

        return sampledCoordinates;
    }

    ordenarYFiltrarCasetas(uniqueCasetas) {
        return Array.from(uniqueCasetas.values())
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
    }

    async findTollboothsInRoute(coordinates) {
        const startTime = Date.now();
        try {
            const uniqueCasetas = new Map();
            const routeDistance = this.calculateDistanceAlongRoute(coordinates) / 1000;
            console.log(`Distancia de ruta: ${routeDistance.toFixed(2)} km`);

            const sampledCoordinates = this.sampleCoordinates(coordinates, routeDistance);
            console.log(`Puntos de muestreo: ${sampledCoordinates.length}`);

            for (let i = 0; i < sampledCoordinates.length; i += 10) {
                const chunk = sampledCoordinates.slice(i, i + 10);
                
                await Promise.all(chunk.map(([lon, lat]) => 
                    this.limit(async () => {
                        try {
                            const casetas = await TollBooth.findNearby(lon, lat, this.routeConfig.initialSearchRadius);
                            console.log(`Buscando cerca de [${lon}, ${lat}], encontradas: ${casetas.length} casetas`);
                
                            for (const caseta of casetas) {
                                if (!uniqueCasetas.has(caseta._id.toString())) {
                                    const casetaPoint = caseta.ubicacion.coordinates;
                                    let minDistance = Infinity;
                                    let validSegment = null;

                                    // Determinamos el segmento más cercano a la caseta
                                    for (let j = 0; j < coordinates.length - 1; j++) {
                                        const segment = [coordinates[j], coordinates[j + 1]];
                                        const result = this.calculatePerpendicularDistance(
                                            casetaPoint,
                                            segment[0],
                                            segment[1]
                                        );
                                        
                                        if (result.distance < minDistance) {
                                            minDistance = result.distance;
                                            validSegment = segment;
                                        }
                                    }
                                    
                                    console.log(`\nAnálisis detallado de caseta ${caseta.nombre}:`);
                                    console.log(`- Coordenadas caseta: [${casetaPoint}]`);
                                    console.log(`- Distancia mínima: ${minDistance.toFixed(2)}m`);
                                    
                                    // Se acepta la caseta sólo si está a menos o igual de 5m (mainRoadThreshold)
                                    const withinDistance = minDistance <= this.routeConfig.mainRoadThreshold;

                                    console.log(`- Aceptada por distancia: ${withinDistance ? 'Sí' : 'No'}`);

                                    if (withinDistance) {
                                        console.log('✅ Caseta dentro del umbral de distancia');
                                        uniqueCasetas.set(caseta._id.toString(), {
                                            ...caseta.toObject(),
                                            distanceOnRoute: this.calculateDistanceAlongRoute(
                                                coordinates.slice(0, coordinates.indexOf(validSegment[0]) + 1)
                                            )
                                        });
                                    } else {
                                        console.log(`❌ Caseta ignorada: distancia fuera del umbral de 5m`);
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('Error en findTollboothsInRoute:', error);
                            return [];
                        }
                    })
                ));

                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const casetasOrdenadas = this.ordenarYFiltrarCasetas(uniqueCasetas);
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
                    timeout: 30000
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
