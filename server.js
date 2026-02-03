const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return true;
}

// Content filtering
const bannedWords = [
  'كس', 'زب', 'طيز', 'حمار', 'ديوث', 'عاهرة', 'ساقطة', 'شرموطة',
  'تناك', 'نيك', 'سحاق', 'لواط', 'جنس', 'جنسي', 'جنسية',
  'بغي', 'فاجرة', 'قحبة', 'دعارة', 'فاحشة', 'فسق', 'فاسق',
  'ملعون', 'ملعونة', 'خنزير', 'خنزيرة', 'كلب', 'كلبة',
  'fuck', 'shit', 'ass', 'bitch', 'whore', 'slut', 'porn', 'sex',
  'xxx', 'nude', 'naked', 'cock', 'pussy', 'dick', 'cum',
  'rape', 'pedophile', 'pedo', 'child', 'minor'
];

const adultKeywords = [
  'إباحي', 'اباحي', 'جنسي', 'جنسية', 'عاري', 'عارية', 'عري',
  'جسد', 'ثدي', 'ثديين', 'صدر', 'مثير', 'مثيرة', 'إثارة',
  'جنس', 'ممارسة', 'علاقة', 'حميمية', 'حميم',
  'adult', 'sex', 'porn', 'xxx', 'nude', 'naked', 'erotic'
];

function filterContent(message) {
  const lowerMessage = message.toLowerCase();
  const errors = [];
  
  for (const word of bannedWords) {
    if (lowerMessage.includes(word)) {
      errors.push(`تم اكتشاف كلمة محظورة: "${word}"`);
    }
  }
  
  let adultContentCount = 0;
  for (const keyword of adultKeywords) {
    if (lowerMessage.includes(keyword)) {
      adultContentCount++;
    }
  }
  
  if (adultContentCount >= 2) {
    errors.push('تم اكتشاف محتوى إباحي. لا يمكن معالجة هذا الطلب.');
  }
  
  return {
    isClean: errors.length === 0,
    errors: errors,
    message: errors.length > 0 ? errors.join(' | ') : null
  };
}

// API endpoint
app.post('/api/chat', async (req, res) => {
  const clientIP = req.ip;
  
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      error: 'عذراً، لقد تجاوزت حد الطلبات. يرجى الانتظار قليلاً.',
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }
  
  const { message } = req.body;
  
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({
      error: 'يرجى إدخال رسالة صحيحة',
      code: 'INVALID_MESSAGE'
    });
  }
  
  const filterResult = filterContent(message);
  
  if (!filterResult.isClean) {
    console.warn(`تم رفض رسالة من ${clientIP}: ${filterResult.message}`);
    return res.status(400).json({
      error: filterResult.message || 'الرسالة تحتوي على محتوى غير مناسب',
      code: 'CONTENT_FILTERED'
    });
  }
  
  if (!GEMINI_API_KEY) {
    console.error('خطأ: لم يتم العثور على GEMINI_API_KEY');
    return res.status(500).json({
      error: 'خطأ في الخادم: مفتاح API غير موجود',
      code: 'MISSING_API_KEY'
    });
  }
  
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: message
              }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7
        }
      },
      {
        timeout: 30000
      }
    );
    
    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!reply) {
      console.error('لم يتمكن Gemini من توليد رد');
      return res.status(500).json({
        error: 'لم يتمكن النموذج من توليد رد',
        code: 'GENERATION_FAILED'
      });
    }
    
    console.log(`رد من Gemini: ${reply.substring(0, 50)}...`);
    
    return res.status(200).json({
      reply: reply,
      success: true
    });
    
  } catch (error) {
    console.error('خطأ في الاتصال مع Gemini:', error.message);
    
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Gemini API مشغول. يرجى المحاولة لاحقاً.',
        code: 'API_RATE_LIMIT'
      });
    }
    
    if (error.response?.status === 401) {
      return res.status(500).json({
        error: 'خطأ في مفتاح API',
        code: 'INVALID_API_KEY'
      });
    }
    
    return res.status(500).json({
      error: 'خطأ في الاتصال بالخادم',
      code: 'SERVER_ERROR'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'الخادم يعمل بشكل صحيح',
    timestamp: new Date().toISOString()
  });
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         Monte AI Server                ║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`✅ الخادم يعمل على http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api/chat`);
  console.log(`📍 الواجهة: http://localhost:${PORT}`);
  console.log('\n⚠️  اضغط Ctrl+C للإيقاف\n');
});

process.on('SIGINT', () => {
  console.log('\n\nتم إيقاف الخادم.');
  process.exit(0);
});
