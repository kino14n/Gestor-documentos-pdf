const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create uploads folder if doesn't exist
const uploadFolder = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)){
    fs.mkdirSync(uploadFolder);
}

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadFolder);
  },
  filename: (req, file, cb) => {
    // Use timestamp + original extension
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Initialize SQLite DB
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) {
    console.error(err.message);
  } else {
    db.run(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      codes TEXT NOT NULL,
      filePath TEXT NOT NULL
    )`);
  }
});

// API Routes

// Create document
app.post('/api/documents', upload.single('docFile'), (req, res) => {
  const { docName, docDate, docCodes } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No se envió archivo PDF.' });
  }

  if (!docName || !docDate || !docCodes) {
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  const filePath = '/uploads/' + path.basename(req.file.path);

  db.run(`INSERT INTO documents (name, date, codes, filePath) VALUES (?, ?, ?, ?)`,
    [docName, docDate, docCodes, filePath], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ id: this.lastID });
    });
});

// Get all documents
app.get('/api/documents', (req, res) => {
  db.all('SELECT * FROM documents ORDER BY date DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Update document (with optional new file upload)
app.put('/api/documents/:id', upload.single('docFile'), (req, res) => {
  const { id } = req.params;
  const { docName, docDate, docCodes } = req.body;

  if (!docName || !docDate || !docCodes) {
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  function updateDocument(filePath) {
    const query = `UPDATE documents SET name = ?, date = ?, codes = ?, filePath = ? WHERE id = ?`;
    db.run(query, [docName, docDate, docCodes, filePath, id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: 'Documento no encontrado' });
      res.json({ success: true });
    });
  }

  if (req.file) {
    // First get old file path to delete old file
    db.get('SELECT filePath FROM documents WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Documento no encontrado' });

      const oldFile = path.join(__dirname, row.filePath);
      if (fs.existsSync(oldFile)) {
        fs.unlink(oldFile, (err) => {
          if (err) console.error('Error eliminando archivo antiguo:', err);
        });
      }

      const newFilePath = '/uploads/' + path.basename(req.file.path);
      updateDocument(newFilePath);
    });
  } else {
    // No new file uploaded - keep current filePath
    db.get('SELECT filePath FROM documents WHERE id = ?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Documento no encontrado' });
      updateDocument(row.filePath);
    });
  }
});

// Delete document
app.delete('/api/documents/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT filePath FROM documents WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Documento no encontrado' });

    const fileToDelete = path.join(__dirname, row.filePath);

    db.run('DELETE FROM documents WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Delete file
      if (fs.existsSync(fileToDelete)) {
        fs.unlink(fileToDelete, (err) => {
          if (err) console.error('Error eliminando archivo:', err);
        });
      }
      res.json({ success: true });
    });
  });
});

// Search documents by codes (implementing complex logic)
app.post('/api/search', (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'Códigos inválidos o vacíos.' });
  }

  // Obtener todos documentos de la BD
  db.all('SELECT * FROM documents', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Formatear los códigos de cada documento como Set para búsqueda
    const docs = rows.map(d => ({
      ...d,
      codeSet: new Set(d.codes.split(',').map(c => c.trim().toUpperCase()))
    }));

    const searchCodes = codes.map(c => c.trim().toUpperCase()).filter(c => c.length > 0);

    // Mapa code -> docs que incluyen el código ordenados por fecha descendente
    const codeDocsMap = new Map();
    for (const code of searchCodes) {
      const docsWithCode = docs.filter(doc => doc.codeSet.has(code))
                               .sort((a,b) => new Date(b.date) - new Date(a.date));
      codeDocsMap.set(code, docsWithCode);
    }

    // Validar códigos sin documentos
    const missingCodes = searchCodes.filter(c => codeDocsMap.get(c) && codeDocsMap.get(c).length === 0);
    if (missingCodes.length > 0) {
      // Puede retornar error o devolver documentos encontrados ignorando los que no aparecen
      // Aquí decidimos devolver documentos encontrados y aviso
    }

    // Construir mapa docId -> documentación y códigos cubiertos
    const docCoverage = new Map();
    for (const code of searchCodes) {
      const docsForCode = codeDocsMap.get(code) || [];
      for (const doc of docsForCode) {
        if (!docCoverage.has(doc.id)) {
          docCoverage.set(doc.id, { doc, codesFound: new Set() });
        }
        docCoverage.get(doc.id).codesFound.add(code);
      }
    }

    // Ordenar documentos por cantidad de códigos cubiertos (desc) y fecha (desc)
    const docsArray = Array.from(docCoverage.values())
                           .sort((a,b) => {
      if (b.codesFound.size !== a.codesFound.size) return b.codesFound.size - a.codesFound.size;
      return new Date(b.doc.date) - new Date(a.doc.date);
    });

    const codesLeft = new Set(searchCodes);
    const selectedDocs = [];

    while(codesLeft.size > 0 && docsArray.length > 0) {
      let bestDocIndex = -1;
      let bestCoverCount = -1;
      for(let i = 0; i  docsArray.length; i++) {
        const coverCount = [...docsArray[i].codesFound].filter(c => codesLeft.has(c)).length;
        if (coverCount > bestCoverCount) {
          bestCoverCount = coverCount;
          bestDocIndex = i;
        }
      }
      if (bestDocIndex === -1) break;
      const bestDoc = docsArray[bestDocIndex];
      selectedDocs.push(bestDoc.doc);
      for(const code of bestDoc.codesFound) {
        codesLeft.delete(code);
      }
      docsArray.splice(bestDocIndex,1);
    }

    // Devuelve documentos seleccionados que cubren los códigos buscando minimizar
    res.json(selectedDocs.map(d => ({
      id: d.id,
      name: d.name,
      date: d.date,
      codes: d.codes,
      filePath: d.filePath
    })));
  });
});

// Servir index.html para otras rutas (SPA support)
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`Servidor arrancado en http://localhost:${PORT}`);
});
