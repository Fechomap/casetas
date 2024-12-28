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
            mainRoadThreshold: 5
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

    formatCoordinates(lat, lon) {
        return `${lat.toFixed(6)},${lon.toFixed(6)}`;
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
                const [prevLat, prevLon] = prevCaseta.coordenadas.split(',').map(Number);
                const [currLat, currLon] = caseta.coordenadas.split(',').map(Number);
                
                return this.haversineDistance(
                    prevLat, prevLon,
                    currLat, currLon
                ) >= this.routeConfig.minTollboothDistance;
            });
    }

    async findTollboothsInRoute(coordinates) {
        try {
            const uniqueCasetas = new Map();
            const evaluatedCasetas = [];  // Cambiamos a array para mejor ordenamiento
            const routeDistance = this.calculateDistanceAlongRoute(coordinates) / 1000;
            const sampledCoordinates = this.sampleCoordinates(coordinates, routeDistance);
            const processedIds = new Set();  // Para control de duplicados
    
            for (let i = 0; i < sampledCoordinates.length; i += 10) {
                const chunk = sampledCoordinates.slice(i, i + 10);
                
                await Promise.all(chunk.map(([lon, lat]) => 
                    this.limit(async () => {
                        try {
                            const casetas = await TollBooth.findNearby(lon, lat, this.routeConfig.initialSearchRadius);
                
                            for (const caseta of casetas) {
                                const casetaId = caseta._id.toString();
                                if (!processedIds.has(casetaId)) {
                                    processedIds.add(casetaId);
                                    const casetaPoint = caseta.ubicacion.coordinates;
                                    let minDistance = Infinity;
                                    let validSegment = null;
    
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
                                    
                                    const withinDistance = minDistance <= this.routeConfig.mainRoadThreshold;
    
                                    // Almacenar datos de evaluación
                                    evaluatedCasetas.push({
                                        id: casetaId,
                                        name: caseta.nombre,
                                        distance: minDistance,
                                        accepted: withinDistance,
                                        caseta: caseta,
                                        validSegment: validSegment
                                    });
    
                                    if (withinDistance) {
                                        uniqueCasetas.set(casetaId, {
                                            ...caseta.toObject(),
                                            distanceOnRoute: this.calculateDistanceAlongRoute(
                                                coordinates.slice(0, coordinates.indexOf(validSegment[0]) + 1)
                                            )
                                        });
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('Error en procesamiento de casetas:', error);
                        }
                    })
                ));
            }
    
            // Ordenar casetas por distancia y estado (aceptadas primero)
            evaluatedCasetas.sort((a, b) => {
                if (a.accepted && !b.accepted) return -1;
                if (!a.accepted && b.accepted) return 1;
                return a.distance - b.distance;
            });
    
            // Imprimir resultados ordenados
            evaluatedCasetas.forEach(evaluation => {
                const status = evaluation.accepted ? '✅' : '❌';
                console.log(`${status} Caseta "${evaluation.name}" - ${evaluation.distance.toFixed(2)}m`);
            });
    
            // Resumen analítico
            console.log('\n📊 RESUMEN ANALÍTICO DE CASETAS');
            console.log('==============================');
            console.log(`Total evaluadas: ${evaluatedCasetas.length}`);
            console.log(`Aceptadas: ${evaluatedCasetas.filter(e => e.accepted).length}`);
            console.log(`Rechazadas: ${evaluatedCasetas.filter(e => !e.accepted).length}`);
            
            return Array.from(uniqueCasetas.values());
    
        } catch (error) {
            console.error('Error en findTollboothsInRoute:', error);
            return [];
        }
    }
    
    // Agregar este nuevo método a la clase
    generateAnalyticsSummary(evaluatedCasetas) {
        // Ordenar casetas por distancia
        const sortedCasetas = [...evaluatedCasetas].sort((a, b) => a.distance - b.distance);
        
        console.log('\n📊 RESUMEN ANALÍTICO DE CASETAS');
        console.log('==============================');
        console.log(`Total evaluadas: ${sortedCasetas.length}`);
        console.log(`Aceptadas: ${sortedCasetas.filter(c => c.accepted).length}`);
        console.log(`Rechazadas: ${sortedCasetas.filter(c => !c.accepted).length}`);
        console.log('\n📍 EVALUACIÓN DETALLADA (ordenada por distancia)');
        console.log('----------------------------------------');
        
        sortedCasetas.forEach(caseta => {
            const status = caseta.accepted ? '✅' : '❌';
            console.log(`${status} ${caseta.name} - ${caseta.distance.toFixed(2)}m`);
        });
        console.log('----------------------------------------\n');
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
            return cachedResult;
        }

        try {            
            const routeResponse = await this.getHereRoute(originLat, originLon, destLat, destLon);
            if (!routeResponse || !routeResponse.route) {
                throw new Error('No se pudo obtener la ruta desde HERE Maps');
            }

            const encodedPolyline = routeResponse.route.sections[0].polyline;
            const decoded = decode(encodedPolyline);
            const coordinates = decoded.polyline.map(([lat, lon]) => [lon, lat]);

            const casetas = await this.findTollboothsInRoute(coordinates);

            const result = {
                distancia: routeResponse.distance,
                tiempo: routeResponse.duration,
                casetas: casetas.map(caseta => ({
                    ...caseta,
                    coordenadas: caseta.coordenadas || this.formatCoordinates(
                        caseta.ubicacion.coordinates[1],
                        caseta.ubicacion.coordinates[0]
                    )
                })),
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

