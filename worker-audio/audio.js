/**
 * audio.js — Cloudflare Worker para transcrição de áudio via Workers AI (Whisper).
 *
 * Modelo: @cf/openai/whisper
 * Recebe áudio (base64 ou binário) via POST e retorna texto transcrito.
 *
 * Deploy: npx wrangler deploy
 */

export default {
  async fetch(request, env) {
    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // --- Health check ---
    if (request.method === "GET") {
      return Response.json({ status: "ok", model: "@cf/openai/whisper" });
    }

    // --- Apenas POST ---
    if (request.method !== "POST") {
      return Response.json({ error: "Método não permitido. Use POST." }, { status: 405 });
    }

    // --- Autenticação via Bearer token (opcional) ---
    const authHeader = request.headers.get("Authorization") || "";
    const expectedToken = env.AUTH_TOKEN || "";
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return Response.json({ error: "Não autorizado" }, { status: 401 });
    }

    try {
      let audioBuffer;
      const contentType = request.headers.get("Content-Type") || "";

      if (contentType.includes("application/json")) {
        // --- Receber áudio como base64 no body JSON ---
        const body = await request.json();
        const base64Audio = body.audio || body.base64 || "";

        if (!base64Audio) {
          return Response.json(
            { error: "Campo 'audio' (base64) é obrigatório no body JSON." },
            { status: 400 }
          );
        }

        // Converter base64 para buffer
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        audioBuffer = bytes.buffer;
      } else {
        // --- Receber áudio como binary (raw bytes) ---
        audioBuffer = await request.arrayBuffer();
      }

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return Response.json(
          { error: "Áudio vazio. Envie bytes válidos." },
          { status: 400 }
        );
      }

      // --- Transcrever via Workers AI (Whisper) ---
      const result = await env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(audioBuffer)],
      });

      const text = (result.text || "").trim();

      return Response.json(
        {
          text: text,
          vtt: result.vtt || null,
          word_count: result.word_count || null,
          words: result.words || null,
        },
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error("Erro na transcrição:", err);
      return Response.json(
        { error: "Erro na transcrição", detail: err.message },
        { status: 500 }
      );
    }
  },
};
