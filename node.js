// time-auction-server/index.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
    origin: "http://localhost:5173", // 請確保與你的 Vue 開發伺服器地址一致
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "http://localhost:5173", // 請確保與你的 Vue 開發伺服器地址一致
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 遊戲房間的數據結構
const games = {}; // { roomId: { id, players: [], status, currentRound, maxRounds, preRoundCountdown, preRoundIntervalId, roundTimerIntervalId, activePlayersInRound: [], ... } }

// 幫助函數：生成隨機房間ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Socket.IO 連接事件處理
io.on('connection', (socket) => {
    console.log(`一位用戶連接了！Socket ID: ${socket.id}`);

    // --- 房間管理事件 ---

    // 創建房間
    socket.on('createRoom', (playerName, callback) => {
        const roomId = generateRoomId();
        const newPlayer = {
            id: socket.id,
            name: playerName,
            time: 600, // 初始時間
            tokens: 0,
            lastHoldDuration: 0,
            isHoldingButton: false, // 新增：是否按住按鈕
            hasOptedOut: false, // 新增：本輪是否已放棄
        };

        games[roomId] = {
            id: roomId,
            players: [newPlayer],
            status: 'waiting', // 'waiting', 'playing', 'gameOver'
            currentRound: 0,
            maxRounds: 19,
            preRoundCountdown: 0,
            preRoundIntervalId: null,
            roundTimerIntervalId: null,
            activePlayersInRound: [], // 實際參與競標的玩家
            // ... 其他遊戲狀態
        };
        socket.join(roomId); // 將 socket 加入房間
        socket.roomId = roomId; // 記錄 socket 所屬的房間

        console.log(`玩家 ${playerName} 創建了房間：${roomId}`);
        callback({ success: true, roomId: roomId, player: newPlayer }); // 返回房間ID和玩家資訊給前端

        // 廣播房間內玩家列表
        io.to(roomId).emit('playerStatusUpdate', games[roomId].players);
    });

    // 加入房間
    socket.on('joinRoom', (roomId, playerName, callback) => {
        const game = games[roomId];
        if (!game) {
            callback({ success: false, message: '房間不存在！' });
            return;
        }
        if (game.status !== 'waiting') {
            callback({ success: false, message: '遊戲已開始，無法加入！' });
            return;
        }
        if (game.players.length >= 4) { // 假設最多4人
            callback({ success: false, message: '房間已滿！' });
            return;
        }

        const newPlayer = {
            id: socket.id,
            name: playerName,
            time: 600,
            tokens: 0,
            lastHoldDuration: 0,
            isHoldingButton: false, // 新增
            hasOptedOut: false, // 新增
        };
        game.players.push(newPlayer);
        socket.join(roomId);
        socket.roomId = roomId;

        console.log(`玩家 ${playerName} 加入了房間：${roomId}`);
        callback({ success: true, roomId: roomId, player: newPlayer });

        // 廣播房間內玩家列表
        io.to(roomId).emit('playerStatusUpdate', game.players);
    });

    // 離開房間
    socket.on('leaveRoom', () => {
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            game.players = game.players.filter(p => p.id !== socket.id); // 從玩家列表中移除

            if (game.players.length === 0) {
                // 如果房間內沒有玩家了，清理房間
                console.log(`房間 ${roomId} 已清空，正在移除。`);
                // 清理所有計時器
                clearInterval(game.preRoundIntervalId);
                clearInterval(game.roundTimerIntervalId);
                delete games[roomId];
            } else {
                // 廣播更新後的玩家列表
                io.to(roomId).emit('playerStatusUpdate', game.players);
                console.log(`玩家 ${socket.id} 離開了房間：${roomId}`);
            }
            socket.leave(roomId); // 離開 socket.io 房間
            delete socket.roomId; // 移除 socket 上的房間記錄
        }
    });

    // --- 玩家按鈕操作事件 ---

    // 玩家按住按鈕
    socket.on('playerHolding', () => {
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            const player = game.players.find(p => p.id === socket.id);

            if (player && !player.isHoldingButton) {
                player.isHoldingButton = true;
                io.to(roomId).emit('playerStatusUpdate', game.players); // 廣播狀態更新
                console.log(`玩家 ${player.name} 在房間 ${roomId} 按住了按鈕。`);

                // **TODO: 在這裡檢查是否所有玩家都按住了，如果是，則啟動倒數**
                // 這部分邏輯會比較複雜，需要判斷當前是否已經在倒數中，或者是否已經在競標中
                // 避免重複啟動倒數
            }
        }
    });

    // 玩家放開按鈕
    socket.on('playerReleased', () => {
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            const player = game.players.find(p => p.id === socket.id);

            if (player && player.isHoldingButton) {
                player.isHoldingButton = false;
                io.to(roomId).emit('playerStatusUpdate', game.players); // 廣播狀態更新
                console.log(`玩家 ${player.name} 在房間 ${roomId} 放開了按鈕。`);

                // **TODO: 在這裡處理倒數中斷邏輯**
                // 如果倒數正在進行，則停止倒數，並將此玩家標記為放棄本輪
                // 然後重新評估是否還有其他玩家在堅持，或者直接結束本輪
            }
        }
    });

    // --- 斷開連接 ---
    socket.on('disconnect', () => {
        console.log(`用戶斷開連接。Socket ID: ${socket.id}`);
        // 處理玩家斷開時自動離開房間
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            game.players = game.players.filter(p => p.id !== socket.id);

            if (game.players.length === 0) {
                console.log(`房間 ${roomId} 因所有玩家離開而移除。`);
                clearInterval(game.preRoundIntervalId);
                clearInterval(game.roundTimerIntervalId);
                delete games[roomId];
            } else {
                io.to(roomId).emit('playerStatusUpdate', game.players);
                console.log(`玩家 ${socket.id} 斷開連接，離開了房間：${roomId}`);
            }
        }
    });
});

// 啟動伺服器
server.listen(PORT, () => {
    console.log(`伺服器運行在 http://localhost:${PORT}`);
});

// --- 遊戲邏輯函數 (將從前端 App.vue 遷移到此處) ---

// 這些函數將由後端調用和控制，並通過 Socket.IO 廣播狀態
function startPreRoundCountdown(roomId) {
    // 實現倒數邏輯，每秒廣播 preRoundCountdownUpdate
    // 倒數結束後，呼叫 handlePreRoundEndOnServer
}

function handlePreRoundEndOnServer(roomId) {
    // 處理倒數結束後的邏輯，判斷誰參與競標，啟動競標計時
}

function checkAllReleasedOnServer(roomId) {
    // 檢查所有參與競標的玩家是否都放手了
    // 如果都放手，停止計時器並呼叫 endRoundOnServer
}

function endRoundOnServer(roomId) {
    // 判斷贏家、扣除時間、發放代幣，廣播 roundEnded 事件
    // 然後檢查遊戲是否結束，否則延遲後呼叫 startNewRound
}

function startNewRound(roomId) {
    // 增加回合數，重置狀態，並再次呼叫 startPreRoundCountdown
}

function gameEnded(roomId, finalMessage) {
    // 遊戲結束處理，廣播 gameOver 事件
}