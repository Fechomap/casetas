// src/models/TollBooth.js
const mongoose = require('mongoose');

const tollBoothSchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: [true, 'El nombre de la caseta es requerido'],
        trim: true,
        maxlength: [100, 'El nombre no puede exceder los 100 caracteres']
    },
    ubicacion: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point',
            required: true
        },
        coordinates: {
            type: [Number], // [longitud, latitud]
            required: [true, 'Las coordenadas son requeridas'],
            validate: {
                validator: function(coordinates) {
                    // Validar que sean exactamente 2 coordenadas
                    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
                        return false;
                    }
                    // Validar rango de coordenadas
                    const [lon, lat] = coordinates;
                    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
                },
                message: 'Coordenadas inválidas. Debe ser [longitud, latitud] con valores válidos'
            }
        }
    },
    costo: {
        auto: { 
            type: Number, 
            required: [true, 'El costo para auto es requerido'],
            min: [0, 'El costo no puede ser negativo'],
            validate: {
                validator: Number.isFinite,
                message: 'El costo debe ser un número válido'
            }
        },
        camion: { 
            type: Number, 
            required: [true, 'El costo para camión es requerido'],
            min: [0, 'El costo no puede ser negativo'],
            validate: {
                validator: Number.isFinite,
                message: 'El costo debe ser un número válido'
            }
        },
        autobus: { 
            type: Number, 
            required: [true, 'El costo para autobús es requerido'],
            min: [0, 'El costo no puede ser negativo'],
            validate: {
                validator: Number.isFinite,
                message: 'El costo debe ser un número válido'
            }
        }
    },
    carretera: {
        nombre: { 
            type: String, 
            required: [true, 'El nombre de la carretera es requerido'],
            trim: true,
            maxlength: [200, 'El nombre de la carretera no puede exceder los 200 caracteres']
        },
        tramo: { 
            type: String, 
            required: [true, 'El tramo es requerido'],
            trim: true,
            maxlength: [200, 'El tramo no puede exceder los 200 caracteres']
        }
    },
    sentido: {
        type: String,
        enum: {
            values: ['N-S', 'S-N', 'E-O', 'O-E'],
            message: '{VALUE} no es un sentido válido'
        },
        required: [true, 'El sentido es requerido']
    }
}, {
    timestamps: true, // Agrega createdAt y updatedAt
    toJSON: { 
        virtuals: true,
        transform: function(doc, ret) {
            delete ret.__v;
            return ret;
        }
    }
});

// Crear índice geoespacial
tollBoothSchema.index({ ubicacion: '2dsphere' });

// Índices adicionales para mejora de rendimiento
tollBoothSchema.index({ 'carretera.nombre': 1 });
tollBoothSchema.index({ sentido: 1 });

// Método estático para buscar casetas cercanas
tollBoothSchema.statics.findNearby = async function(longitude, latitude, maxDistance = 2000) {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Buscando casetas cerca de [${longitude}, ${latitude}] con radio ${maxDistance}m`);
            const casetas = await this.find({
                ubicacion: {
                    $near: {
                        $geometry: {
                            type: 'Point',
                            coordinates: [longitude, latitude]
                        },
                        $maxDistance: maxDistance
                    }
                }
            }).maxTimeMS(5000).exec();
            
            console.log(`Encontradas ${casetas.length} casetas en el radio`);
            return casetas;
        } catch (error) {
            console.error(`Intento ${attempt}/${maxRetries} fallido:`, error);
            
            if (attempt === maxRetries) {
                console.error('Error al buscar casetas cercanas después de todos los reintentos');
                return [];
            }

            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
    }
    return [];
};

// Método para formatear costos
tollBoothSchema.methods.formatCostos = function() {
    return {
        auto: `$${this.costo.auto.toFixed(2)}`,
        camion: `$${this.costo.camion.toFixed(2)}`,
        autobus: `$${this.costo.autobus.toFixed(2)}`
    };
};

// Middleware pre-save para validación adicional
tollBoothSchema.pre('save', function(next) {
    // Asegurar que las coordenadas estén en el orden correcto [longitud, latitud]
    if (this.ubicacion.coordinates[1] < -90 || this.ubicacion.coordinates[1] > 90) {
        next(new Error('La latitud debe estar entre -90 y 90 grados'));
    } else if (this.ubicacion.coordinates[0] < -180 || this.ubicacion.coordinates[0] > 180) {
        next(new Error('La longitud debe estar entre -180 y 180 grados'));
    }
    next();
});

// Virtual para obtener URL de Google Maps
tollBoothSchema.virtual('googleMapsUrl').get(function() {
    const [lon, lat] = this.ubicacion.coordinates;
    return `https://www.google.com/maps?q=${lat},${lon}`;
});

const TollBooth = mongoose.model('TollBooth', tollBoothSchema);

module.exports = TollBooth;