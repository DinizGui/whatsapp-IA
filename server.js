/**
 * WhatsApp IA - Backend Node.js
 * Integração Evolution API + OpenAI (GPT, Whisper, Vision)
 *
 * Variáveis de ambiente necessárias:
 * - OPENAI_API_KEY
 * - EVOLUTION_URL
 * - EVOLUTION_API_KEY
 * - INSTANCE_NAME
 * - PORT (opcional, default: 3000)
 */

import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============ Configuração ============
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Validação das variáveis de ambiente
const requiredEnvVars = ['OPENAI_API_KEY', 'EVOLUTION_URL', 'EVOLUTION_API_KEY', 'INSTANCE_NAME'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`⚠️  Aviso: ${envVar} não está definida. Configure antes do deploy.`);
  }
}

// Cliente OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============ Função para enviar mensagem via Evolution API ============
/**
 * Envia mensagem de texto para um número via Evolution API
 * @param {string} number - Número do destinatário (ex: 5511999999999)
 * @param {string} text - Texto da mensagem
 */
async function sendMessage(number, text) {
  const url = `${process.env.EVOLUTION_URL}/message/sendText/${process.env.INSTANCE_NAME}`;
  
  try {
    const response = await axios.post(url, { number, text }, {
      headers: {
        apikey: process.env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ Mensagem enviada para ${number}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem para ${number}:`, error.response?.data || error.message);
    throw error;
  }
}

// ============ Função para baixar arquivo (áudio ou imagem) ============
// Evolution API pode exigir apikey no header para URLs de mídia
async function downloadFile(url) {
  const config = {
    responseType: 'arraybuffer',
  };
  if (process.env.EVOLUTION_API_KEY) {
    config.headers = { apikey: process.env.EVOLUTION_API_KEY };
  }
  const response = await axios.get(url, config);
  return Buffer.from(response.data);
}

// ============ Processar áudio (Whisper + GPT) ============
async function processAudio(audioUrl) {
  console.log('🎤 Processando áudio...');
  
  // 1. Baixar o áudio
  const audioBuffer = await downloadFile(audioUrl);
  
  // 2. Salvar em arquivo temporário (Whisper SDK aceita createReadStream)
  const tempPath = path.join(__dirname, `temp_audio_${Date.now()}.ogg`);
  fs.writeFileSync(tempPath, audioBuffer);
  
  try {
    const transcriptResponse = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
    });
    
    const transcription = transcriptResponse.text;
    console.log('📝 Transcrição:', transcription);
    
    // 3. Gerar resposta com GPT
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um assistente prestativo. Responda de forma clara e concisa.' },
        { role: 'user', content: transcription },
      ],
      max_tokens: 500,
    });
    
    return gptResponse.choices[0].message.content;
  } finally {
    // Remove arquivo temporário
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// ============ Processar imagem (Vision) ============
async function processImage(imageUrl) {
  console.log('🖼️ Processando imagem...');
  
  // 1. Baixar a imagem
  const imageBuffer = await downloadFile(imageUrl);
  const base64Image = imageBuffer.toString('base64');
  
  // 2. Analisar com GPT-4 Vision (gpt-4.1-mini)
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Descreva esta imagem de forma clara e detalhada em português. Se for uma pergunta ou pedido, responda adequadamente.',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: 500,
  });
  
  return response.choices[0].message.content;
}

// ============ Processar texto (GPT) ============
async function processText(text) {
  console.log('💬 Processando texto:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Você é um assistente prestativo. Responda de forma clara e concisa em português.' },
      { role: 'user', content: text },
    ],
    max_tokens: 500,
  });
  
  return response.choices[0].message.content;
}

// ============ Rota POST /webhook ============
/**
 * Recebe eventos da Evolution API
 * Estrutura esperada do payload: evento do webhook da Evolution
 */
app.post('/webhook', async (req, res) => {
  console.log('\n📥 Webhook recebido');
  
  // Responde imediatamente para evitar timeout
  res.status(200).json({ received: true });
  
  try {
    const payload = req.body;
    
    // Evolution API envia diferentes estruturas - extrair dados da mensagem
    const message = payload.data?.message || payload.message;
    const key = payload.data?.key || payload.key;
    
    if (!message || !key) {
      console.log('⚠️ Payload sem mensagem ou key, ignorando');
      return;
    }
    
    const remoteJid = key.remoteJid || key.from;
    const isFromMe = key.fromMe;
    
    // Ignora mensagens enviadas por nós mesmos
    if (isFromMe) {
      console.log('⏭️ Mensagem própria ignorada');
      return;
    }
    
    // Extrair número (remover sufixo @s.whatsapp.net)
    const number = remoteJid?.replace('@s.whatsapp.net', '') || remoteJid;
    
    let responseText = null;
    
    // 1. Verifica se é áudio
    if (message.audioMessage) {
      const audioUrl = message.audioMessage.url;
      if (!audioUrl) {
        console.log('⚠️ Áudio sem URL');
        return;
      }
      responseText = await processAudio(audioUrl);
    }
    // 2. Verifica se é imagem
    else if (message.imageMessage) {
      const imageUrl = message.imageMessage.url;
      if (!imageUrl) {
        console.log('⚠️ Imagem sem URL');
        return;
      }
      responseText = await processImage(imageUrl);
    }
    // 3. Verifica se é texto
    else if (message.conversation) {
      const text = message.conversation;
      responseText = await processText(text);
    }
    // Evolution também pode usar extendedTextMessage para textos longos
    else if (message.extendedTextMessage?.text) {
      const text = message.extendedTextMessage.text;
      responseText = await processText(text);
    }
    else {
      console.log('⚠️ Tipo de mensagem não suportado:', Object.keys(message));
      await sendMessage(number, 'Desculpe, ainda não suporto este tipo de mensagem. Envie texto, áudio ou imagem.');
      return;
    }
    
    if (responseText && number) {
      await sendMessage(number, responseText);
    }
    
  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    console.error(error.stack);
    
    // Tenta enviar mensagem de erro ao usuário
    try {
      const payload = req.body;
      const key = payload?.data?.key || payload?.key;
      const remoteJid = key?.remoteJid || key?.from;
      const number = remoteJid?.replace('@s.whatsapp.net', '');
      if (number) {
        await sendMessage(number, 'Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente.');
      }
    } catch (sendError) {
      console.error('❌ Erro ao enviar mensagem de erro:', sendError.message);
    }
  }
});

// ============ Rota de health check (útil para Railway) ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'whatsapp-ia',
    message: 'Webhook Evolution API + OpenAI',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// ============ Iniciar servidor ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Webhook: POST /webhook`);
  console.log(`🔧 Configure o webhook na Evolution API: ${process.env.EVOLUTION_URL}/webhook/set\n`);
});
