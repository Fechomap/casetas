// utils/excelUtils.js
const Excel = require('excel4node');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
require('dotenv').config();

async function exportToExcel() {
    const uri = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0.jbyof.mongodb.net/tollboothdb`;
    const client = new MongoClient(uri);
    
    try {
        await client.connect();
        console.log('✅ Conectado a MongoDB');
        
        const db = client.db('tollboothdb');
        const collection = db.collection('tollbooths');
        
        // Obtener casetas
        const tollbooths = await collection.find({}).toArray();
        
        // Crear libro de Excel
        const wb = new Excel.Workbook();
        const ws = wb.addWorksheet('Casetas');
        
        // Definir encabezados
        const headers = [
            'Nombre',
            'Longitud',
            'Latitud',
            'Costo Auto',
            'Costo Camión',
            'Costo Autobús',
            'Carretera',
            'Tramo',
            'Sentido'
        ];
        
        // Estilo para encabezados
        const headerStyle = wb.createStyle({
            font: {
                bold: true,
                color: '#FFFFFF',
            },
            fill: {
                type: 'pattern',
                patternType: 'solid',
                fgColor: '#4472C4'
            }
        });
        
        // Escribir encabezados
        headers.forEach((header, i) => {
            ws.cell(1, i + 1)
              .string(header)
              .style(headerStyle);
        });
        
        // Escribir datos
        tollbooths.forEach((booth, index) => {
            const row = index + 2;
            ws.cell(row, 1).string(booth.nombre || '');
            ws.cell(row, 2).number(booth.ubicacion?.coordinates[0] || 0);
            ws.cell(row, 3).number(booth.ubicacion?.coordinates[1] || 0);
            ws.cell(row, 4).number(booth.costo?.auto || 0);
            ws.cell(row, 5).number(booth.costo?.camion || 0);
            ws.cell(row, 6).number(booth.costo?.autobus || 0);
            ws.cell(row, 7).string(booth.carretera?.nombre || '');
            ws.cell(row, 8).string(booth.carretera?.tramo || '');
            ws.cell(row, 9).string(booth.sentido || '');
        });
        
        // Guardar archivo
        await wb.write('data/casetas.xlsx');
        console.log('✅ Datos exportados a data/casetas.xlsx');
        
    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.close();
    }
}

async function importFromExcel(filePath = 'data/casetas.xlsx') {
    const uri = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0.jbyof.mongodb.net/tollboothdb`;
    const client = new MongoClient(uri);
    
    try {
        // Leer archivo Excel
        const workbook = XLSX.readFile(filePath);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(worksheet);
        
        // Convertir datos a formato MongoDB
        const tollbooths = data.map(row => ({
            nombre: row.Nombre,
            ubicacion: {
                type: 'Point',
                coordinates: [Number(row.Longitud), Number(row.Latitud)]
            },
            costo: {
                auto: Number(row['Costo Auto']),
                camion: Number(row['Costo Camión']),
                autobus: Number(row['Costo Autobús'])
            },
            carretera: {
                nombre: row.Carretera,
                tramo: row.Tramo
            },
            sentido: row.Sentido
        }));
        
        // Conectar a MongoDB
        await client.connect();
        console.log('✅ Conectado a MongoDB');
        
        const db = client.db('tollboothdb');
        const collection = db.collection('tollbooths');
        
        // Eliminar datos existentes
        await collection.deleteMany({});
        console.log('✅ Colección limpiada');
        
        // Insertar nuevos datos
        const result = await collection.insertMany(tollbooths);
        console.log(`✅ ${result.insertedCount} casetas importadas`);
        
        // Crear índice geoespacial
        await collection.createIndex({ "ubicacion": "2dsphere" });
        console.log('✅ Índice geoespacial creado');
        
    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.close();
    }
}

module.exports = { exportToExcel, importFromExcel };

// Si se ejecuta directamente
if (require.main === module) {
    const command = process.argv[2];
    const filePath = process.argv[3];
    
    if (command === 'export') {
        exportToExcel().catch(console.error);
    } else if (command === 'import') {
        importFromExcel(filePath).catch(console.error);
    } else {
        console.log('Uso: node excelUtils.js [export|import] [archivo.xlsx]');
    }
}