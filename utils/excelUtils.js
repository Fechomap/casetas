// utils/excelUtils.js
require('dotenv').config();
const XLSX = require('xlsx');
const mongoose = require('mongoose');
const TollBooth = require('../src/models/TollBooth');

const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@cluster0.jbyof.mongodb.net/tollboothdb?retryWrites=true&w=majority`;

// Rutas fijas para el archivo Excel
const EXCEL_PATH = 'data/casetas.xlsx';

function validateCoordinates(coordStr) {
    if (!coordStr || typeof coordStr !== 'string') return null;
    
    const cleaned = coordStr.trim().replace(/\s+/g, '').replace(/;/g, ',');
    const parts = cleaned.split(',');
    if (parts.length !== 2) return null;
    
    const [lat, lon] = parts.map(Number);
    
    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    
    return {
        coordStr: `${lat},${lon}`,
        lat,
        lon
    };
}

function validateCost(cost) {
    const num = Number(cost);
    return !isNaN(num) && num >= 0 ? num : 0;
}

async function importFromExcel(filename) {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado a MongoDB');

        const filePath = filename || EXCEL_PATH;
        console.log(`📄 Leyendo archivo: ${filePath}`);

        // Leer archivo Excel
        const workbook = XLSX.readFile(filePath);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`📊 Total de registros a procesar: ${data.length}`);

        const validRecords = [];
        const invalidRecords = [];

        // Procesar cada registro
        for (const row of data) {
            const coordData = validateCoordinates(row['Coordenadas']);
            
            if (!coordData) {
                invalidRecords.push({
                    nombre: row['Nombre'],
                    error: 'Coordenadas inválidas',
                    data: row
                });
                continue;
            }

            try {
                const tollbooth = {
                    nombre: row['Nombre']?.trim() || 'Sin nombre',
                    coordenadas: coordData.coordStr,
                    ubicacion: {
                        type: 'Point',
                        coordinates: [coordData.lon, coordData.lat]
                    },
                    costo: {
                        auto: validateCost(row['Costo Auto']),
                        camion: validateCost(row['Costo Camión']),
                        autobus: validateCost(row['Costo Autobús'])
                    },
                    carretera: {
                        nombre: row['Carretera']?.trim() || 'Sin especificar',
                        tramo: row['Tramo']?.trim() || 'Sin especificar'
                    }
                };

                validRecords.push(tollbooth);
            } catch (error) {
                invalidRecords.push({
                    nombre: row['Nombre'],
                    error: error.message,
                    data: row
                });
            }
        }

        // Limpiar colección e insertar nuevos registros
        if (validRecords.length > 0) {
            await TollBooth.deleteMany({});
            await TollBooth.insertMany(validRecords, { ordered: false });
            console.log(`\n✅ ${validRecords.length} registros importados exitosamente`);
        }

        // Mostrar resumen
        console.log('\n📊 Resumen de importación:');
        console.log(`Total registros: ${data.length}`);
        console.log(`Registros válidos: ${validRecords.length}`);
        console.log(`Registros inválidos: ${invalidRecords.length}`);

    } catch (error) {
        console.error('❌ Error durante la importación:', error);
    } finally {
        await mongoose.connection.close();
        console.log('\n📡 Conexión a MongoDB cerrada');
    }
}

async function exportToExcel() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado a MongoDB');

        const casetas = await TollBooth.find({});
        console.log(`📊 Registros encontrados: ${casetas.length}`);

        if (casetas.length === 0) {
            console.log('⚠️ No hay datos para exportar');
            return;
        }
        
        const excelData = casetas.map(caseta => ({
            'Nombre': caseta.nombre,
            'Coordenadas': caseta.coordenadas,
            'Costo Auto': caseta.costo.auto,
            'Costo Camión': caseta.costo.camion,
            'Costo Autobús': caseta.costo.autobus,
            'Carretera': caseta.carretera.nombre,
            'Tramo': caseta.carretera.tramo
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(excelData);

        ws['!cols'] = [
            { wch: 30 }, // Nombre
            { wch: 25 }, // Coordenadas
            { wch: 15 }, // Costo Auto
            { wch: 15 }, // Costo Camión
            { wch: 15 }, // Costo Autobús
            { wch: 30 }, // Carretera
            { wch: 30 }  // Tramo
        ];

        XLSX.utils.book_append_sheet(wb, ws, 'Casetas');
        XLSX.writeFile(wb, EXCEL_PATH);
        
        console.log(`✅ Datos exportados a ${EXCEL_PATH}`);
    } catch (error) {
        console.error('❌ Error durante la exportación:', error);
    } finally {
        await mongoose.connection.close();
        console.log('📡 Conexión a MongoDB cerrada');
    }
}

// Procesar argumentos
const command = process.argv[2];
const filename = process.argv[3];

if (command === 'export') {
    exportToExcel();
} else if (command === 'import') {
    importFromExcel(filename);
} else {
    console.log('Uso: node utils/excelUtils.js [export|import] [filename]');
    console.log('Ejemplos:');
    console.log('  node utils/excelUtils.js export');
    console.log('  node utils/excelUtils.js import data/casetas.xlsx');
}