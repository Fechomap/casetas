const mongoose = require('mongoose');

const tollBoothSchema = new mongoose.Schema({
    nombre: {
        type: String,
        required: [true, 'El nombre de la caseta es requerido'],
        trim: true,
        maxlength: [100, 'El nombre no puede exceder los 100 caracteres']
    },
    coordenadas: {
        type: String,
        required: [true, 'Las coordenadas son requeridas'],
        validate: {
            validator: function(value) {
                // Validar formato "latitud,longitud"
                const pattern = /^-?\d+\.?\d*,-?\d+\.?\d*$/;
                if (!pattern.test(value)) return false;
                
                const [lat, lon] = value.split(',').map(Number);
                return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
            },
            message: 'Formato de coordenadas inválido. Debe ser "latitud,longitud" con valores válidos'
        }
    },
    ubicacion: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point',
            required: true
        },
        coordinates: {
            type: [Number],
            required: true,
            index: '2dsphere'
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
    }
}, {
    timestamps: true,
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

// Middleware para mantener sincronizados coordenadas y ubicacion
tollBoothSchema.pre('save', function(next) {
    if (this.coordenadas) {
        const [lat, lon] = this.coordenadas.split(',').map(Number);
        this.ubicacion = {
            type: 'Point',
            coordinates: [lon, lat] // MongoDB usa [longitud, latitud]
        };
    }
    next();
});

// Método estático para buscar casetas cercanas
tollBoothSchema.statics.findNearby = async function(longitude, latitude, maxDistance = 2000) {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Solo mantener un log con información útil
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
            
            return casetas;
        } catch (error) {
            if (attempt === maxRetries) {
                console.error('Error al buscar casetas cercanas después de todos los reintentos:', error);
                return [];
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
    }
    return [];
};

// Virtual para obtener URL de Google Maps
tollBoothSchema.virtual('googleMapsUrl').get(function() {
    if (this.coordenadas) {
        const [lat, lon] = this.coordenadas.split(',');
        return `https://www.google.com/maps?q=${lat},${lon}`;
    }
    return null;
});

const TollBooth = mongoose.model('TollBooth', tollBoothSchema);

module.exports = TollBooth;