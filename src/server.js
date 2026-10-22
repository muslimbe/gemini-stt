import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { run } from './pipeline.js';
import { extractReason } from './gemini.js';
import { log } from './logger.js';

const TOOL_DESC =
  'Transcribe a voice note, audio file or video the user sent. Pass the absolute path from its ' +
  '`[attachment: <path> type=audio/… | video/…]` marker. Handles Uzbek, Russian and English (code-switching ' +
  'included) and labels speakers when there is more than one. Returns the transcript text. ' +
  'Takes roughly 10–60 s per few minutes of audio.';

// Stateless: a fresh server per request, so nothing is shared between calls.
function createMcp() {
  const mcp = new McpServer({ name: 'gemini-stt', version: '0.2.0' });
  mcp.registerTool(
    'transcribe',
    {
      description: TOOL_DESC,
      inputSchema: { path: z.string().describe(`Absolute path of the audio/video file, under ${config.mediaDir}.`) },
    },
    async ({ path }) => {
      try {
        return { content: [{ type: 'text', text: await run(path) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Transcription failed: ${extractReason(err)}` }], isError: true };
      }
    },
  );
  return mcp;
}

const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
  const mcp = createMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    log(`✗ request failed: ${inspect(err, { depth: 5 })}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

// An hour of audio can take longer than Node's 5-minute default request timeout.
server.requestTimeout = 0;

process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));

server.listen(config.port, () => {
  log(`▶ gemini-stt listening on :${config.port}/mcp`);
  log(`  model:     ${config.geminiModel}`);
  log(`  media dir: ${config.mediaDir}`);
});
