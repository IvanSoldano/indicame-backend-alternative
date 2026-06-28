require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const altIndicaciones = require('./routes/altIndicaciones');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(morgan('dev'));   // logs: METHOD /path STATUS response-time
app.use(express.json());

// Mount routes
app.use('/api/alt/indicaciones', altIndicaciones);

// Health check
app.get('/', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
