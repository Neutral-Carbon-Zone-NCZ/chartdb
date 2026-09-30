// Prints public/config.js for the container: window.env from runtime
// variables, JSON-encoded so values cannot break out of the script.
const KEYS = [
    'OPENAI_API_KEY',
    'OPENAI_API_ENDPOINT',
    'LLM_MODEL_NAME',
    'HIDE_CHARTDB_CLOUD',
    'DISABLE_ANALYTICS',
];

const env = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key] ?? ''])
);

process.stdout.write(`window.env = ${JSON.stringify(env)};\n`);
