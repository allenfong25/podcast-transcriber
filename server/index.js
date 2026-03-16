const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const { processAudioWithOpenAI } = require('./services/openaiService');
const { downloadPodcastAudio } = require('./services/podcastService');
const { getAudioFiles, estimateAudioDuration } = require('./services/audioInfoService');
const { cleanupAudioFiles } = require('./utils/fileSaver');
const { formatSizeKB, formatSizeMB, estimateAudioDurationFromSize } = require('./utils/formatUtils');
const logger = require('./utils/logger');

const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    req.startTime = Date.now();

    logger.info('request_started', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl
    });

    res.on('finish', () => {
        logger.info('request_finished', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            durationMs: Date.now() - req.startTime
        });
    });

    next();
});

// 创建临时文件夹
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// 文件上传配置
const upload = multer({
    dest: tempDir,
    limits: {
        fileSize: (process.env.MAX_FILE_SIZE || 50) * 1024 * 1024 // 默认50MB
    }
});

// 进度推送存储
const progressClients = new Map();

// SSE 进度推送端点
app.get('/api/progress/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(`🔌 新的SSE连接: sessionId=${sessionId}`);
    
    // 设置 SSE 头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // 存储客户端连接
    progressClients.set(sessionId, res);
    console.log(`📝 已存储客户端连接，当前连接数: ${progressClients.size}`);
    
    // 发送初始连接确认
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
    
    // 客户端断开连接时清理
    req.on('close', () => {
        console.log(`🔌 SSE连接断开: sessionId=${sessionId}`);
        progressClients.delete(sessionId);
    });
});

// 发送进度更新的辅助函数
function sendProgress(sessionId, progress, stage, stageText) {
    console.log(`📊 尝试发送进度: sessionId=${sessionId}, progress=${progress}%, stage=${stage}, text=${stageText}`);
    const client = progressClients.get(sessionId);
    if (client) {
        const data = {
            type: 'progress',
            progress: Math.round(progress),
            stage,
            stageText
        };
        console.log(`✅ 发送进度更新: ${JSON.stringify(data)}`);
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    } else {
        console.log(`❌ 未找到 sessionId=${sessionId} 的客户端连接`);
    }
}

// API路由
app.post('/api/process-podcast', async (req, res) => {
    try {
        const { url, operation, audioLanguage, outputLanguage, sessionId } = req.body;

        console.log('处理播客请求:', {
            url,
            operation,
            audioLanguage,
            outputLanguage,
            sessionId,
            requestId: req.requestId
        });
        logger.info('process_podcast_requested', {
            requestId: req.requestId,
            url,
            operation,
            audioLanguage,
            outputLanguage,
            sessionId
        });

        // 验证输入
        if (!url) {
            return res.status(400).json({
                success: false,
                error: '播客链接是必需的 / Podcast URL is required'
            });
        }

        if (!['transcribe_only', 'transcribe_summarize'].includes(operation)) {
            return res.status(400).json({
                success: false,
                error: '无效的操作类型 / Invalid operation type'
            });
        }

        // 步骤1: 下载音频文件
        console.log('下载音频文件...');
        if (sessionId) {
            const stageText = outputLanguage === 'zh' ? '处理音频' : 'Processing Audio';
            sendProgress(sessionId, 10, 'download', stageText);
        }
        
        const podcastInfo = await downloadPodcastAudio(url);
        
        if (!podcastInfo || !podcastInfo.audioFilePath) {
            return res.status(400).json({
                success: false,
                error: '无法下载音频文件，请检查链接是否有效 / Unable to download audio file, please check if the link is valid'
            });
        }

        const originalAudioPath = podcastInfo.audioFilePath;
        const podcastTitle = podcastInfo.title || 'Untitled Podcast';

        // 步骤2: 基于文件大小估算时长（用于初始预估）
        console.log('📊 估算音频时长...');
        if (sessionId) {
            const stageText = outputLanguage === 'zh' ? '处理音频' : 'Processing Audio';
            sendProgress(sessionId, 20, 'download', stageText);
        }
        
        const estimatedDuration = await estimateAudioDuration(originalAudioPath);
        console.log(`🎯 预估时长: ${Math.round(estimatedDuration / 60)} 分钟 ${Math.round(estimatedDuration % 60)} 秒`);

        // 步骤3: 获取音频文件信息
        console.log('🔍 获取音频文件信息...');
        const audioFiles = await getAudioFiles(originalAudioPath);
        
        const shouldSummarize = operation === 'transcribe_summarize';
        console.log(`📋 处理模式: ${shouldSummarize ? '转录+总结' : '仅转录'}`);
        
        // 步骤4: 使用本地Whisper处理音频
        console.log(`🤖 本地转录处理 ${audioFiles.length} 个音频文件...`);
        if (sessionId) {
            const stageText = outputLanguage === 'zh' ? '转录' : 'Transcription';
            sendProgress(sessionId, 30, 'transcription', stageText);
        }
        
        const result = await processAudioWithOpenAI(audioFiles, shouldSummarize, outputLanguage, tempDir, audioLanguage, url, sessionId, sendProgress, podcastTitle);

        // 步骤4: 获取保存的文件信息
        const savedFiles = result.savedFiles || [];
        console.log(`✅ 处理完成，共保存 ${savedFiles.length} 个文件`);
        
        // 打印保存的文件详情
        savedFiles.forEach(file => {
            console.log(`📁 ${file.type}: ${file.filename} (${formatSizeKB(file.size)})`);
        });

        // 步骤5: 清理音频临时文件
        cleanupAudioFiles(originalAudioPath, audioFiles);

        // 发送完成进度
        if (sessionId) {
            const stageText = outputLanguage === 'zh' ? '处理完成' : 'Complete';
            sendProgress(sessionId, 100, 'complete', stageText);
        }

        // 返回结果（包含估算和真实时长）
        res.json({
            success: true,
            data: {
                ...result,
                podcastTitle: podcastTitle, // 播客标题
                estimatedDuration: estimatedDuration, // 估算时长（秒）
                actualDuration: result.audioDuration || result.duration, // 从Whisper获取的真实时长
                savedFiles: savedFiles
            }
        });

    } catch (error) {
        console.error('处理播客时出错:', error);
        
        logger.error('process_podcast_failed', error, {
            requestId: req.requestId,
            body: {
                url: req.body?.url,
                operation: req.body?.operation,
                audioLanguage: req.body?.audioLanguage,
                outputLanguage: req.body?.outputLanguage,
                sessionId: req.body?.sessionId
            }
        });

        res.status(500).json({
            success: false,
            error: error.message || '服务器内部错误 / Internal server error',
            requestId: req.requestId
        });
    }
});

// 本地文件处理端点
app.post('/api/process-local-file', async (req, res) => {
    try {
        const {
            filename,
            operation = 'transcribe_only',
            outputLanguage = 'zh',
            audioLanguage = 'auto'
        } = req.body;
        
        if (!filename) {
            return res.status(400).json({
                success: false,
                error: '缺少文件名参数'
            });
        }
        
        const filePath = path.join(tempDir, filename);
        
        // 安全检查：确保文件在temp目录内
        if (!filePath.startsWith(tempDir)) {
            return res.status(400).json({
                success: false,
                error: '无效的文件路径'
            });
        }
        
        // 检查文件是否存在
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: '文件未找到'
            });
        }
        
        console.log(`📂 处理本地文件: ${filename}`);
        console.log(`📋 处理模式: ${operation === 'transcribe_summarize' ? '转录+总结' : '仅转录'}`);
        
        const shouldSummarize = operation === 'transcribe_summarize';
        
        // 使用本地Whisper处理音频
        console.log(`🤖 本地转录处理文件: ${filename}`);
        const result = await processAudioWithOpenAI([filePath], shouldSummarize, outputLanguage, tempDir, audioLanguage, null);

        // 获取保存的文件信息
        const savedFiles = result.savedFiles || [];
        console.log(`✅ 处理完成，共保存 ${savedFiles.length} 个文件`);
        
        // 打印保存的文件详情
        savedFiles.forEach(file => {
            console.log(`📁 ${file.type}: ${file.filename} (${formatSizeKB(file.size)})`);
        });
        
        // 返回结果
        res.json({
            success: true,
            data: {
                ...result,
                savedFiles: savedFiles
            }
        });
        
    } catch (error) {
        console.error('本地文件处理失败:', error);
        logger.error('process_local_file_failed', error, {
            requestId: req.requestId,
            body: req.body
        });

        res.status(500).json({
            success: false,
            error: error.message || '本地文件处理失败',
            requestId: req.requestId
        });
    }
});

// 获取temp目录文件列表端点
app.get('/api/temp-files', (req, res) => {
    try {
        const files = fs.readdirSync(tempDir)
            .filter(file => 
                // 音频文件
                file.endsWith('.m4a') || file.endsWith('.mp3') || file.endsWith('.wav') ||
                // 转录和总结文件
                file.endsWith('_transcript.md') || file.endsWith('_summary.md') ||
                // 其他文本文件
                file.endsWith('.txt') || file.endsWith('.md')
            )
            .map(file => {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    size: stats.size,
                    created: stats.ctime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.modified - a.modified);
            
        res.json({
            success: true,
            files: files
        });
        
    } catch (error) {
        console.error('获取文件列表失败:', error);
        res.status(500).json({
            success: false,
            error: '获取文件列表失败'
        });
    }
});

// 文件下载端点
app.get('/api/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(tempDir, filename);

        // 安全检查：确保文件在temp目录内
        if (!filePath.startsWith(tempDir)) {
            return res.status(400).json({
                success: false,
                error: '无效的文件路径'
            });
        }

        // 检查文件是否存在
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: '文件未找到'
            });
        }

        // 设置下载响应头
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');

        // 发送文件
        res.sendFile(filePath);

    } catch (error) {
        console.error('文件下载失败:', error);
        res.status(500).json({
            success: false,
            error: '文件下载失败'
        });
    }
});

// 健康检查端点
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// 音频时长预估端点 - 轻量级，只获取文件大小
app.post('/api/estimate-duration', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: '请提供音频链接'
            });
        }

        console.log(`🔍 轻量级预估音频时长: ${url}`);
        
        // 使用 HEAD 请求获取文件大小，不下载完整文件
        const headResponse = await axios.head(url, {
            timeout: 10000, // 10秒超时
            maxRedirects: 5
        });
        
        const contentLength = parseInt(headResponse.headers['content-length'] || '0');
        if (contentLength > 0) {
            // 基于文件大小估算时长（使用统一工具函数）
            const estimatedDuration = estimateAudioDurationFromSize(contentLength);
            
            console.log(`📊 文件大小: ${formatSizeMB(contentLength)}，预估时长: ${Math.round(estimatedDuration / 60)} 分钟`);
            
            res.json({
                success: true,
                estimatedDuration: estimatedDuration // 返回秒数
            });
        } else {
            // 无法获取文件大小，返回默认估算
            console.log(`⚠️ 无法获取文件大小，使用默认估算`);
            res.json({
                success: true,
                estimatedDuration: 600 // 默认10分钟
            });
        }
        
    } catch (error) {
        console.error('❌ 预估音频时长失败:', error);
        // 失败时返回默认估算，不阻塞主流程
        res.json({
            success: true,
            estimatedDuration: 600 // 默认10分钟
        });
    }
});

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('未处理的错误:', error);
    logger.error('unhandled_request_error', error, {
        requestId: req?.requestId,
        method: req?.method,
        path: req?.originalUrl
    });
    res.status(500).json({
        success: false,
        error: '服务器内部错误 / Internal server error',
        requestId: req?.requestId
    });
});

// 404处理
app.use((req, res) => {
    if (req.url.startsWith('/api/')) {
        res.status(404).json({
            success: false,
            error: 'API端点未找到 / API endpoint not found'
        });
    } else {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    }
});

// 启动服务器（简化版端口处理）
function startServer() {
    const server = app.listen(DEFAULT_PORT, () => {
        console.log(`🎙️ Podcast提取器服务器运行在 http://localhost:${DEFAULT_PORT}`);
        console.log(`🎙️ Podcast Transcriber server running on http://localhost:${DEFAULT_PORT}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`端口 ${DEFAULT_PORT} 被占用，尝试端口 ${DEFAULT_PORT + 1}...`);
            const altServer = app.listen(DEFAULT_PORT + 1, () => {
                console.log(`🎙️ Podcast提取器服务器运行在 http://localhost:${DEFAULT_PORT + 1}`);
                console.log(`🎙️ Podcast Transcriber server running on http://localhost:${DEFAULT_PORT + 1}`);
            });
            
            altServer.on('error', (altErr) => {
                if (altErr.code === 'EADDRINUSE') {
                    console.log(`端口 ${DEFAULT_PORT + 1} 也被占用，尝试端口 ${DEFAULT_PORT + 2}...`);
                    app.listen(DEFAULT_PORT + 2, () => {
                        console.log(`🎙️ Podcast提取器服务器运行在 http://localhost:${DEFAULT_PORT + 2}`);
                        console.log(`🎙️ Podcast Transcriber server running on http://localhost:${DEFAULT_PORT + 2}`);
                    });
                } else {
                    console.error('启动服务器失败:', altErr);
                    process.exit(1);
                }
            });
        } else {
            console.error('启动服务器失败:', err);
            process.exit(1);
        }
    });
}

startServer();

process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', error);
});

process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
