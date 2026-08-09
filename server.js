import express from 'express';
import fs from 'fs';
import path from 'path';
import * as Rivet from '@ironclad/rivet-node';

// ============================================================================
// BLOCK 1: INITIALIZATION & CONFIGURATION
// ============================================================================
const app = express();
app.use(express.json());

const PORT = 3001;
const RIVET_PROJECT_PATH = path.resolve('./workflow1.rivet-project');
const RIVET_GRAPH_NAME = 'agent';
const LOG_DIR = path.resolve('./logs');

const debuggerServer = Rivet.startDebuggerServer({ port: 21888 });

// ============================================================================
// BLOCK 2: ROLLING LOGGER & LOCAL TIME
// ============================================================================
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

function getLocalTimestamp() {
    const now = new Date();
    const tzOffset = now.getTimezoneOffset() * 60000;
    const localTime = new Date(now.getTime() - tzOffset);
    return localTime.toISOString().slice(0, 19).replace('T', ' ');
}

function getNextLogFile() {
    let oldestFile = null;
    let oldestTime = Date.now();
    for (let i = 0; i < 10; i++) {
        const filePath = path.join(LOG_DIR, `${i}.log`);
        if (!fs.existsSync(filePath)) return filePath;
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < oldestTime) {
            oldestTime = stats.mtimeMs;
            oldestFile = filePath;
        }
    }
    return oldestFile;
}

const currentLogFile = getNextLogFile();
fs.writeFileSync(currentLogFile, `--- Log Session Started at ${getLocalTimestamp()} ---\n`);

const originalConsoleLog = console.log;
console.log = function(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    const timestamp = getLocalTimestamp();
    fs.appendFileSync(currentLogFile, `[${timestamp}] [SCRIPT] ${msg}\n`);
    originalConsoleLog(msg);
};

function logEvent(source, message) {
    const timestamp = getLocalTimestamp();
    const logLine = `[${timestamp}] [${source.toUpperCase()}] ${message}`;

    fs.appendFileSync(currentLogFile, logLine + '\n');

    if (source === 'rivet-node' && !message.includes('[Code]')) {
        return;
    }

    originalConsoleLog(logLine);
}

logEvent('server', `Server initialized. Logging to ${path.basename(currentLogFile)}`);
logEvent('server', `Rivet debug on ws://localhost:21888`);

// ============================================================================
// BLOCK 3: INPUT PARSERS (CONTINUE -> RIVET)
// ============================================================================

function extractChatInputs(messages) {
    const chatHistory = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
        type: m.role === 'assistant' ? 'assistant' : 'user',
        message: m.content
    }));

    logEvent('server', `Processed Chat input. History length: ${chatHistory.length} messages.`);

    return {
        prompt: { type: 'chat-message[]', value: chatHistory },
        existing_code: { type: 'string', value: "" },
        selected_code: { type: 'string', value: "" }
    };
}

//Парсер для /v1/completions (Ctrl+I)
function extractCompletionInputs(promptString) {
    logEvent('server', 'Processed Inline Edit input.');

    let messages = [];

    if (promptString.includes('<|im_start|>')) {
        const parts = promptString.split('<|im_start|>assistant');

        const userMsg = parts[0].replace('<|im_start|>user', '').replace('<|im_end|>', '').trim();
        messages.push({ type: 'user', message: userMsg });

        if (parts.length > 1) {
            const assistantMsg = parts[1].replace('<|im_end|>', '').trim();
            messages.push({ type: 'assistant', message: assistantMsg });
        }
    } else {
        messages.push({ type: 'user', message: promptString.trim() });
    }

    return {
        prompt: { type: 'chat-message[]', value: messages }
    };
}

// ============================================================================
// BLOCK 4: RIVET OPTIONS BUILDER
// ============================================================================
function getRivetOptions(graphInputs, abortController) {
    return {
        graph: RIVET_GRAPH_NAME,
        inputs: graphInputs,
        remoteDebugger: debuggerServer,
        abortSignal: abortController.signal,

        onNodeStart: (event) => {
            const title = event.node?.title || event.node?.type || 'Unknown Node';
            logEvent('rivet-node', `▶ START: [${title}]`);
        },
        onNodeFinish: (event) => {
            const title = event.node?.title || event.node?.type || 'Unknown Node';
            logEvent('rivet-node', `■ FINISH: [${title}]`);
        },
        onNodeError: (event) => {
            const title = event.node?.title || event.node?.type || 'Unknown Node';
            logEvent('rivet-node', `✖ ERROR: [${title}] | ${event.error}`);
        }
    };
}

// ============================================================================
// BLOCK 4.5: INTERNAL VECTOR DATABASE (TEMPORARY & PERMANENT MEMORY)
// ============================================================================
let temporaryMemory = [];
let permanentMemory = [];
const PERMANENT_MEMORY_FILE = path.resolve('./permanent_memory.json');

if (fs.existsSync(PERMANENT_MEMORY_FILE)) {
    try {
        permanentMemory = JSON.parse(fs.readFileSync(PERMANENT_MEMORY_FILE, 'utf-8'));
        logEvent('memory', `Loaded ${permanentMemory.length} items from permanent memory.`);
    } catch (e) {
        logEvent('memory', `ERROR reading permanent memory file: ${e.message}`);
    }
}

function savePermanentMemory() {
    fs.writeFileSync(PERMANENT_MEMORY_FILE, JSON.stringify(permanentMemory, null, 2));
}

function chunkText(text, chunkSize = 1200, overlap = 200) {
    const chunks = [];
    for (let i = 0; i < text.length; i += (chunkSize - overlap)) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text) {
    const url = 'http://localhost:8081/v1/embeddings';
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, model: 'local-model' })
    });
    if (!res.ok) throw new Error(`Embedding API failed: ${res.statusText}`);
    const data = await res.json();
    return data.data[0].embedding;
}

//временная память
app.post('/internal/memory/store', async (req, res) => {
    try {
        const { text, source } = req.body;
        const chunks = chunkText(text);
        for (const chunk of chunks) {
            const vector = await getEmbedding(chunk);
            temporaryMemory.push({ text: chunk, source: source, vector: vector });
        }
        res.json({ success: true, chunksSaved: chunks.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

//постоянная память
app.post('/internal/memory/permanent/store', async (req, res) => {
    try {
        const { fact } = req.body;
        if (!fact || fact.trim() === "") {
            throw new Error("Fact text is empty. Cannot generate embedding.");
        }

        const vector = await getEmbedding(fact);
        const id = 'mem_' + Date.now();

        permanentMemory.push({ id, text: fact, vector });
        savePermanentMemory();

        logEvent('memory', `Saved to permanent memory: ID ${id}`);
        res.json({ success: true, id });
    } catch (e) {
        logEvent('memory', `ERROR saving permanent memory: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/memory/permanent/delete', (req, res) => {
    const { id } = req.body;
    const initialLength = permanentMemory.length;
    permanentMemory = permanentMemory.filter(item => item.id !== id);

    if (permanentMemory.length < initialLength) {
        savePermanentMemory();
        logEvent('memory', `Deleted permanent memory: ID ${id}`);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: "ID not found" });
    }
});

app.get('/internal/memory/permanent/list', (req, res) => {
    try {
        if (permanentMemory.length === 0) {
            return res.json({ results: "Permanent memory is currently empty." });
        }

        const formattedList = permanentMemory
        .map((item, index) => `${index + 1}. [ID: ${item.id}]\nText: ${item.text}`)
        .join('\n\n');

        res.json({ results: `PERMANENT MEMORY LIST:\n\n${formattedList}` });
    } catch (e) {
        logEvent('memory', `ERROR listing memory: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

//обе памяти
app.post('/internal/memory/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (temporaryMemory.length === 0 && permanentMemory.length === 0) {
            return res.json({ results: "Both temporary and permanent memories are empty." });
        }

        const queryVector = await getEmbedding(query);

        const scoredTemp = temporaryMemory.map(item => ({
            type: 'temporary', text: item.text, source: item.source, score: cosineSimilarity(queryVector, item.vector)
        }));

        const scoredPerm = permanentMemory.map(item => ({
            type: 'permanent', id: item.id, text: item.text, score: cosineSimilarity(queryVector, item.vector)
        }));

        const combined = [...scoredTemp, ...scoredPerm];
        combined.sort((a, b) => b.score - a.score);
        const topChunks = combined.slice(0, 4);

        const resultText = topChunks.map(c => {
            if (c.type === 'permanent') return `[PERMANENT MEMORY | ID: ${c.id}]\n${c.text}`;
            return `[TEMPORARY MEMORY | Source: ${c.source}]\n${c.text}`;
        }).join('\n\n---\n\n');

        res.json({ results: resultText || "No relevant matches found." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/internal/memory/debug', (req, res) => {
    res.json({
        temporaryCount: temporaryMemory.length,
        permanentCount: permanentMemory.length,
        temporaryMemory: temporaryMemory.map(i => ({ source: i.source, length: i.text.length })),
             permanentMemory: permanentMemory.map(i => ({ id: i.id, text: i.text }))
    });
});

app.get('/internal/memory/permanent/debug', (req, res) => {
    try {
        const readablePermanent = permanentMemory.map(item => ({
            id: item.id,
            vectorSize: item.vector ? item.vector.length : 0,
            text: item.text
        }));

        res.json({
            totalPermanentItems: permanentMemory.length,
            permanentMemory: readablePermanent
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// BLOCK 5: API ENDPOINTS & EXECUTION
// ============================================================================

app.post('/v1/chat/completions', async (req, res) => {
    const messages = req.body.messages || [];
    const isStream = req.body.stream === true;

    //затычка для заголовков
    const lastMsgContent = messages[messages.length - 1]?.content || "";
    if (typeof lastMsgContent === 'string' && lastMsgContent.includes("please reply with a title for the chat")) {
        logEvent('server', 'Intercepted Title Generation Request from Continue. Returning dummy title.');
        const dummyTitle = "Chat Session"; // Текст-заглушка, который появится в названии вкладки

        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const chunk = { choices: [{ delta: { content: dummyTitle } }] };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        } else {
            return res.json({
                choices: [{ message: { role: "assistant", content: dummyTitle } }]
            });
        }
    }

    const abortController = new AbortController();
    let isFinished = false;

    res.on('close', () => {
        if (!isFinished) {
            logEvent('server', 'Client connection closed (Stop Ctrl pressed). Aborting graph execution...');
            abortController.abort();
        }
    });

    try {
        logEvent('vscode', 'Received /v1/chat/completions request from Continue.');

        const graphInputs = extractChatInputs(messages);

        logEvent('server', `Sending inputs to Rivet: ${Object.keys(graphInputs).join(', ')}`);
        logEvent('rivet', 'Starting graph execution...');

        const result = await Rivet.runGraphInFile(
            RIVET_PROJECT_PATH,
            getRivetOptions(graphInputs, abortController)
        );

        if (abortController.signal.aborted) return;

        const rivetOutputStr = result.output ? result.output.value : "Error: No output from Rivet";

        logEvent('rivet', 'Graph execution finished successfully.');
        logEvent('server', `Sending response back to VSCode (Stream: ${isStream}).`);

        isFinished = true;

        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const chunk = { choices: [{ delta: { content: rivetOutputStr } }] };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({
                choices: [{ message: { role: "assistant", content: rivetOutputStr } }]
            });
        }

    } catch (error) {
        if (abortController.signal.aborted) {
            logEvent('rivet', 'Graph execution was successfully aborted.');
            return;
        }

        logEvent('server', `ERROR: ${error.message}`);
        if (!isFinished) res.status(500).json({ error: error.message });
    }
});

app.post('/v1/completions', async (req, res) => {
    const abortController = new AbortController();
    let isFinished = false;

    res.on('close', () => {
        if (!isFinished) {
            logEvent('server', 'Client connection closed (Stop Ctrl pressed). Aborting graph execution...');
            abortController.abort();
        }
    });

    try {
        logEvent('vscode', 'Received /v1/completions request from Continue (Ctrl+I).');

        const promptString = req.body.prompt || "";
        const isStream = req.body.stream === true;
        const graphInputs = extractCompletionInputs(promptString);

        logEvent('server', `Sending inputs to Rivet: ${Object.keys(graphInputs).join(', ')}`);
        logEvent('rivet', 'Starting graph execution...');

        const result = await Rivet.runGraphInFile(
            RIVET_PROJECT_PATH,
            getRivetOptions(graphInputs, abortController)
        );

        if (abortController.signal.aborted) return;

        const rivetOutputStr = result.output ? result.output.value : "Error: No output from Rivet";

        logEvent('rivet', 'Graph execution finished successfully.');
        logEvent('server', `Sending response back to VSCode (Stream: ${isStream}).`);

        isFinished = true;

        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const chunk = { choices: [{ text: rivetOutputStr }] };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({
                choices: [{ text: rivetOutputStr }]
            });
        }

    } catch (error) {
        if (abortController.signal.aborted) {
            logEvent('rivet', 'Graph execution was successfully aborted.');
            return;
        }

        logEvent('server', `ERROR: ${error.message}`);
        if (!isFinished) res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// BLOCK 6: SERVER STARTUP
// ============================================================================
app.listen(PORT, () => {
    logEvent('server', `Rivet integration server is running at http://localhost:${PORT}/v1`);
    logEvent('server', `Temporary memory debug page: http://localhost:${PORT}/internal/memory/debug`);
});
