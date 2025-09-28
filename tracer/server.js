// server.js
const express = require('express');
const mongoose = require('mongoose');

const app = express();

(async () => {
    await mongoose.connect('mongodb://127.0.0.1:27018', { dbName: 'trace_demo' });

    const userSchema = new mongoose.Schema({
        name: String, email: String, age: Number
    }, { timestamps: true });
    const User = mongoose.model('User', userSchema);

    // seed some data
    app.get('/seed', async (_req, res) => {
        await User.deleteMany({});
        await User.insertMany([
            { name: 'Ada', email: 'ada@example.com', age: 27 },
            { name: 'Lin', email: 'lin@example.com', age: 35 },
            { name: 'Sam', email: 'sam@example.com', age: 17 },
        ]);
        res.json({ ok: true, count: await User.countDocuments() });
    });

    // list adults
    app.get('/users', async (_req, res) => {
        const list = await User.find({ age: { $gte: 18 } }).lean().limit(5).exec();
        res.json({ list });
    });

    // single by id
    app.get('/users/:id', async (req, res) => {
        const u = await User.findById(req.params.id).exec();
        res.json({ u });
    });

    // aggregate example
    app.get('/agg', async (_req, res) => {
        const out = await User.aggregate([
            { $group: { _id: null, avgAge: { $avg: '$age' }, count: { $sum: 1 } } }
        ]);
        res.json({ agg: out[0] });
    });

    // native node: fs + crypto + timers
    app.get('/native', async (_req, res) => {
        const fs = require('node:fs/promises');
        const crypto = require('node:crypto');

        console.log('starting native work');

        const src = await fs.readFile(__filename, 'utf8');
        await new Promise((resolve, reject) =>
            crypto.pbkdf2('secret', Buffer.alloc(16, 7), 10_000, 32, 'sha256',
                (err, key) => err ? reject(err) : resolve(key))
        );

        await new Promise(r => setTimeout(r, 20));

        res.json({ ok: true, size: src.length });
    });

    app.listen(3000, () => process.stdout.write('listening on http://localhost:3000\n'));
})();
