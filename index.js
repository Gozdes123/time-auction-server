// time-auction-server/index.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
// CORS 設置，允許前端應用訪問
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173", // 從環境變數獲取前端 URL，或使用預設值
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);
// 初始化 Socket.IO 伺服器，並設定 CORS
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173", // 從環境變數獲取前端 URL，或使用預設值
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000; // 伺服器監聽端口

const games = {}; // 用於儲存所有活躍的遊戲房間數據

// --- 幫助函數 ---

// 生成一個隨機的房間 ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 清除遊戲房間內所有的計時器
function clearGameIntervals(game) {
    if (game.preRoundIntervalId) {
        clearInterval(game.preRoundIntervalId);
        game.preRoundIntervalId = null;
    }
    if (game.roundTimerIntervalId) {
        clearInterval(game.roundTimerIntervalId);
        game.roundTimerIntervalId = null;
    }
}

// 向房間內所有玩家廣播更新後的玩家狀態、當前回合數和總回合數
function broadcastPlayerStatusUpdate(roomId) {
    const game = games[roomId];
    if (game) {
        io.to(roomId).emit('playerStatusUpdate', {
            players: game.players,      // 所有玩家的最新數據
            currentRound: game.currentRound, // 當前回合數
            maxRounds: game.maxRounds,       // 遊戲總回合數
            gameStatus: game.status          // 當前遊戲狀態 (waiting, preCountdown, inRound, gameOver, roundEnded)
        });
    }
}

// 向房間內所有玩家廣播一條通用訊息
function broadcastMessage(roomId, messageText) {
    io.to(roomId).emit('message', messageText);
}

// --- 遊戲流程函數 (由後端控制主要遊戲邏輯) ---

// 開始新回合的準備階段
function startNewRound(roomId) {
    const game = games[roomId];
    if (!game) return;

    console.log(`[GAME_FLOW] Starting new round for room ${roomId}. Current round: ${game.currentRound}, Max rounds: ${game.maxRounds}`);

    // **重要修改**：先檢查是否達到最大回合數來判斷遊戲結束
    // 如果當前回合已經是最大回合數，則遊戲應該結束，而不是開始新的回合準備
    if (game.currentRound >= game.maxRounds) {
        console.log(`[GAME_FLOW] Room ${roomId}: Reached max rounds (${game.maxRounds}). Ending game.`);
        gameEnded(roomId, '所有回合已結束。'); // 觸發遊戲結束，並提供原因
        return; // 遊戲結束，不再繼續開始新回合的準備
    }

    game.currentRound++; // 遞增回合數 (這裡是在檢查完是否遊戲結束後才遞增)

    game.preRoundCountdown = 0; // 重置賽前倒數
    game.roundElapsedTime = 0; // 重置競標時間
    game.status = 'waiting'; // 設定遊戲狀態為等待玩家按住

    // 重置所有玩家的狀態
    game.players.forEach(p => {
        p.isHoldingButton = false;
        p.hasOptedOut = false; // 重置玩家退出標記
        p.roundHoldDuration = 0; // 重置本回合按住時間
    });

    broadcastPlayerStatusUpdate(roomId); // 廣播最新玩家狀態
    broadcastMessage(roomId, `第 ${game.currentRound} 回合：請所有玩家按住準備！`); // 廣播提示訊息

    // 發送 roundEnded 事件，通知前端進入下一個準備階段並同步回合數
    io.to(roomId).emit('roundEnded', {
        message: `第 ${game.currentRound} 回合：請所有玩家按住準備！`,
        updatedPlayers: game.players,
        currentRound: game.currentRound,
        maxRounds: game.maxRounds,
    });
    console.log(`[GAME_FLOW] Round ${game.currentRound} for room ${roomId} started. Status: ${game.status}`);

    // 新增：觸發回合統計 Modal (例如每 3 回合)
    // 確保不是第 0 回合，且是 3 的倍數 (或者您自定義的其他頻率)
    if (game.currentRound > 0 && game.currentRound % 3 === 0 && game.currentRound !== game.maxRounds) {
        io.to(roomId).emit('showRoundStatsModal');
        console.log(`[GAME_FLOW] Room ${roomId}: Triggered Round Stats Modal for Round ${game.currentRound}`);
    }
}


function startPreRoundCountdown(roomId) {
    const game = games[roomId];
    console.log(`[START_COUNTDOWN_FN] Attempting to start countdown for room ${roomId}. Current status: ${game ? game.status : 'N/A'}`);
    // 如果遊戲不存在，或者已經在倒數/競標中，則不執行
    if (!game || game.status === 'preCountdown' || game.status === 'inRound') {
        console.log(`[START_COUNTDOWN_FN] Aborting: Game not found or already in countdown/round. Status: ${game ? game.status : 'N/A'}`);
        return;
    }

    const playerCount = game.players.length;
    const allPlayersHolding = game.players.every(p => p.isHoldingButton); // 檢查所有玩家是否都在按住按鈕

    console.log(`[START_COUNTDOWN_FN] Inside conditions check: Player Count: ${playerCount}, All Holding: ${allPlayersHolding}`);

    let shouldStartCountdown = false;
    if (playerCount === 1) { // 單人測試模式 (只需要 1 人按住)
        if (allPlayersHolding) {
            shouldStartCountdown = true;
        }
    } else { // 正常多人遊戲模式 (需要至少 2 人且所有人都按住)
        if (playerCount >= 2 && allPlayersHolding) {
            shouldStartCountdown = true;
        }
    }

    if (!shouldStartCountdown) {
        console.log(`[START_COUNTDOWN_FN] Conditions ultimately not met. Should Start Countdown: ${shouldStartCountdown}. Aborting countdown.`);
        return;
    }

    console.log(`[START_COUNTDOWN_FN] Countdown conditions MET for room ${roomId}. Starting countdown!`);

    game.status = 'preCountdown'; // 設定遊戲狀態為賽前倒數
    game.preRoundCountdown = 5; // 倒數 5 秒
    // 重置玩家在本回合的狀態
    game.players.forEach(p => {
        p.hasOptedOut = false;
        p.roundHoldDuration = 0;
    });

    broadcastPlayerStatusUpdate(roomId); // 廣播玩家狀態更新 (狀態會顯示為 inGame)
    io.to(roomId).emit('preRoundCountdownUpdate', game.preRoundCountdown); // 廣播倒數時間
    broadcastMessage(roomId, `所有玩家已按住！倒數：${game.preRoundCountdown} 秒`); // 廣播訊息

    // 啟動倒數計時器
    game.preRoundIntervalId = setInterval(() => {
        game.preRoundCountdown--;
        io.to(roomId).emit('preRoundCountdownUpdate', game.preRoundCountdown); // 廣播倒數時間
        console.log(`[COUNTDOWN] Room ${roomId} countdown: ${game.preRoundCountdown}`);

        if (game.preRoundCountdown <= 0) { // 倒數結束
            clearInterval(game.preRoundIntervalId);
            game.preRoundIntervalId = null;
            console.log(`[COUNTDOWN] Room ${roomId} countdown finished.`);
            handlePreRoundEndOnServer(roomId); // 處理賽前倒數結束後的邏輯
        }
    }, 1000);
}

// 處理賽前倒數結束後的邏輯
function handlePreRoundEndOnServer(roomId) {
    const game = games[roomId];
    if (!game) return;

    console.log(`[HANDLE_PRE_ROUND_END] Room ${roomId}: Pre-round countdown ended. Status: ${game.status}`);

    game.players.forEach(p => {
        // 如果玩家在倒數結束時沒有按住按鈕，且沒有明確選擇退出，則標記為退出
        if (!p.isHoldingButton && !p.hasOptedOut) {
            p.hasOptedOut = true;
            console.log(`[HANDLE_PRE_ROUND_END] Player ${p.name} opted out (not holding after countdown).`);
        }
        // 如果玩家時間用盡，且沒有明確選擇退出，則標記為退出並廣播訊息
        if (p.time <= 0 && !p.hasOptedOut) {
            p.hasOptedOut = true;
            broadcastMessage(roomId, `${p.name} 時間已用盡，無法參與本回合！`);
            console.log(`[HANDLE_PRE_ROUND_END] Player ${p.name} opted out (time ran out).`);
        }
    });

    // 過濾出本回合的活躍玩家 (按住按鈕且時間未用盡的玩家)
    game.activePlayersInRound = game.players.filter(p => p.isHoldingButton && !p.hasOptedOut);
    console.log(`[HANDLE_PRE_ROUND_END] Active players for this round: ${game.activePlayersInRound.map(p => p.name).join(', ')}`);

    if (game.activePlayersInRound.length >= 1) { // 如果至少有一位活躍玩家
        game.status = 'inRound'; // 設定遊戲狀態為競標中
        game.roundElapsedTime = 0; // 重置競標計時器

        broadcastMessage(roomId, '競標開始');
        io.to(roomId).emit('roundStarting'); // 通知前端競標開始
        console.log(`[HANDLE_PRE_ROUND_END] Round for room ${roomId} is starting!`);

        // 啟動競標計時器
        game.roundTimerIntervalId = setInterval(() => {
            game.roundElapsedTime++; // 競標時間遞增

            let somePlayerTimeRanOut = false;
            game.players.forEach(p => {
                if (p.isHoldingButton && !p.hasOptedOut) {
                    p.roundHoldDuration++; // 按住時間遞增
                    if (p.time - p.roundHoldDuration <= 0) { // 如果時間用盡
                        p.isHoldingButton = false; // 強制放開按鈕
                        p.roundHoldDuration = p.time; // 將按住時間設定為其總時間（確保不超額）
                        p.hasOptedOut = true; // 標記為退出
                        broadcastMessage(roomId, `${p.name} 的時間用盡了！`);
                        console.log(`[IN_ROUND] Player ${p.name} time ran out and forced release.`);
                        somePlayerTimeRanOut = true; // 標記有玩家時間用盡
                    }
                }
            });
            if (somePlayerTimeRanOut) {
                broadcastPlayerStatusUpdate(roomId); // 如果有玩家時間用盡，更新前端顯示
            }

            io.to(roomId).emit('roundTimerUpdate', game.roundElapsedTime); // 更新競標計時器給前端

            checkAllReleasedOnServer(roomId); // 檢查所有玩家是否都放手
        }, 1000);
    } else { // 無人按住進入競標
        broadcastMessage(roomId, '倒數結束，但無人堅持。本回合無人獲勝。');
        console.log(`[HANDLE_PRE_ROUND_END] No players holding after countdown for room ${roomId}.`);
        setTimeout(() => startNewRound(roomId), 2000); // 2秒後開始新回合
    }
}

// 檢查所有活躍玩家是否都已放手
function checkAllReleasedOnServer(roomId) {
    const game = games[roomId];
    if (!game || game.status !== 'inRound') return; // 只有在競標階段才檢查

    // 檢查所有 "活躍玩家" (本回合可以參與競標的玩家) 是否都已放手或退出
    const allActiveReleased = game.activePlayersInRound.every(p => {
        const currentPlayerState = game.players.find(gp => gp.id === p.id); // 獲取最新玩家狀態
        return !currentPlayerState || (!currentPlayerState.isHoldingButton || currentPlayerState.hasOptedOut);
    });

    if (allActiveReleased) {
        console.log(`[CHECK_RELEASED] All active players in room ${roomId} have released.`);
        clearGameIntervals(game); // 清除競標計時器
        endRoundOnServer(roomId); // 結束回合
    }
}

// 結束當前回合並判斷贏家
function endRoundOnServer(roomId) {
    const game = games[roomId];
    if (!game) return;

    game.status = 'roundEnded'; // 設定遊戲狀態為回合結束

    let winner = null;
    let maxHoldDuration = 0;
    let winningPlayers = []; // 可能有多個贏家（平手）

    // 遍歷活躍玩家，找出按住時間最長的玩家
    game.activePlayersInRound.forEach(p => {
        if (p.roundHoldDuration > maxHoldDuration) {
            maxHoldDuration = p.roundHoldDuration;
            winningPlayers = [p]; // 新的最高分，重置贏家列表
        } else if (p.roundHoldDuration === maxHoldDuration) {
            winningPlayers.push(p); // 平手，添加到贏家列表
        }
    });
    console.log(`[END_ROUND] Room ${roomId}: Max hold duration: ${maxHoldDuration}, Winning Players count: ${winningPlayers.length}`);

    let winnerAnnouncementMessage = ''; // 用於獲勝者公告的訊息

    if (maxHoldDuration === 0 || winningPlayers.length === 0) { // 如果沒有有效按住時間或沒有贏家
        winnerAnnouncementMessage = '本回合無人參與。';
        broadcastMessage(roomId, winnerAnnouncementMessage);
        console.log(`[END_ROUND] Room ${roomId}: No winner.`);
        // 在這種情況下，雖然沒有回合贏家，但回合數依然增加，以便觸發最終的遊戲結束判斷
        // 不需要扣除時間或增加代幣，因為沒有人「贏得」這一輪
    } else {
        if (winningPlayers.length === 1) { // 單一贏家
            winner = winningPlayers[0];
            winner.tokens += 1; // 贏家獲得一個代幣
            winner.time -= maxHoldDuration; // 扣除消耗的時間
            winnerAnnouncementMessage = `${winner.name} 贏得了本回合`;
            broadcastMessage(roomId, winnerAnnouncementMessage);
            console.log(`[END_ROUND] Room ${roomId}: Winner: ${winner.name}`);
        } else { // 平手
            const winnerNames = winningPlayers.map(p => p.name).join(' 和 ');
            winningPlayers.forEach(p => {
                p.tokens += 1; // 平手贏家也獲得代幣
                p.time -= maxHoldDuration; // 扣除消耗的時間
            });
            winnerAnnouncementMessage = `本回合平手！贏家有 ${winnerNames}`;
            broadcastMessage(roomId, winnerAnnouncementMessage);
            console.log(`[END_ROUND] Room ${roomId}: Tie winners: ${winnerNames}`);
        }
    }

    // 發送新的事件給前端，包含獲勝者資訊 (用於彈出公告)
    io.to(roomId).emit('roundWinnerAnnounced', {
        message: winnerAnnouncementMessage,
        winners: winningPlayers.map(p => ({ id: p.id, name: p.name })), // 只發送必要資訊
        duration: maxHoldDuration,
        isTie: winningPlayers.length > 1
    });

    // 重置所有玩家的按鈕狀態和回合數據
    game.players.forEach(p => {
        p.isHoldingButton = false;
        p.hasOptedOut = false;
        p.roundHoldDuration = 0;
    });

    broadcastPlayerStatusUpdate(roomId); // 廣播最終狀態，以便前端更新顯示

    // 檢查遊戲是否結束
    // 這個判斷會被 `startNewRound` 裡面的提前判斷所捕獲
    const isGameOverDueToTime = game.players.some(p => p.time <= 0); // 只有時間用盡才算遊戲直接結束

    console.log(`[END_ROUND] Room ${roomId}: Game Over Due To Time? ${isGameOverDueToTime}. Remaining players time: ${game.players.map(p => `${p.name}:${p.time}`).join(', ')}`);

    setTimeout(() => { // 延遲3秒後，判斷是結束遊戲還是開始新回合
        if (isGameOverDueToTime) { // 如果有玩家時間歸零，立即結束遊戲
            gameEnded(roomId, '有玩家時間耗盡，遊戲結束！');
        } else {
            // 否則，嘗試開始新回合。新回合的邏輯會檢查是否達到 maxRounds
            startNewRound(roomId);
        }
    }, 3000);
}

// 處理遊戲結束的邏輯
function gameEnded(roomId, reason) {
    const game = games[roomId];
    if (!game) return;

    game.status = 'gameOver'; // 設定遊戲狀態為結束
    clearGameIntervals(game); // 清除所有計時器

    let finalWinner = null;

    // **新的最終優勝者判斷邏輯**
    // 1. 找出代幣最多的玩家
    // 2. 如果代幣相同，比較剩餘時間
    const sortedPlayers = [...game.players].sort((a, b) => {
        if (b.tokens !== a.tokens) {
            return b.tokens - a.tokens; // 代幣多的排前面
        }
        return b.time - a.time; // 代幣相同時，時間多的排前面
    });

    if (sortedPlayers.length > 0) {
        // 最前面的玩家就是優勝者（或其中之一，如果有多個平手）
        finalWinner = sortedPlayers[0];
        // 檢查是否有並列的優勝者（代幣和時間都相同）
        const coWinners = sortedPlayers.filter(p => p.tokens === finalWinner.tokens && p.time === finalWinner.time);
        if (coWinners.length > 1) {
            finalWinner = { // 創建一個表示並列優勝者的物件
                isTie: true,
                names: coWinners.map(p => p.name).join(' 和 '), // 並列優勝者名稱
                players: coWinners.map(p => ({ id: p.id, name: p.name, tokens: p.tokens, time: p.time })) // 詳細玩家數據
            };
        } else {
            finalWinner = { // 單一優勝者
                isTie: false,
                name: finalWinner.name,
                id: finalWinner.id,
                tokens: finalWinner.tokens,
                time: finalWinner.time
            };
        }
    }

    // 向所有玩家發送遊戲結束事件，包含排序後的玩家數據和最終優勝者資訊
    io.to(roomId).emit('gameOver', {
        reason: reason,             // 遊戲結束原因
        finalPlayers: sortedPlayers, // 發送排序後的玩家數據
        finalWinner: finalWinner    // 發送最終優勝者資訊 (可能是單一玩家或並列玩家的對象)
    });
    console.log(`[GAME_OVER] Room ${roomId} game ended: ${reason}`);
    console.log(`[GAME_OVER] Final Players (sorted):`, sortedPlayers.map(p => `${p.name} (Tokens: ${p.tokens}, Time: ${p.time})`));
    console.log(`[GAME_OVER] Final Winner:`, finalWinner);

    // 可以選擇在這裡清理房間，或者等待所有玩家斷開連接
    // setTimeout(() => {
    //     delete games[roomId];
    //     console.log(`[GAME_OVER] Room ${roomId} data deleted.`);
    // }, 10000); // 例如 10 秒後清理房間數據
}

// --- Socket.IO 連接事件處理 ---
io.on('connection', (socket) => {
    console.log(`[CONNECT] 一位用戶連接了！Socket ID: ${socket.id}`);

    // 監聽創建房間事件
    socket.on('createRoom', (data, callback) => { // 現在接收一個包含 playerName, initialTime, maxRounds 的數據對象
        const { playerName, initialTime, maxRounds } = data; // 解構數據

        // 後端數據驗證
        if (typeof initialTime !== 'number' || initialTime < 10 || initialTime > 600 || isNaN(initialTime)) {
            callback({ success: false, message: '無效的起始時間 (10-600 秒)。' });
            return;
        }
        if (typeof maxRounds !== 'number' || maxRounds < 1 || maxRounds > 50 || isNaN(maxRounds)) {
            callback({ success: false, message: '無效的遊戲回合數 (1-50 回合)。' });
            return;
        }

        const roomId = generateRoomId(); // 生成新的房間 ID
        const newPlayer = { // 創建新的玩家物件
            id: socket.id,
            name: playerName,
            time: initialTime, // 使用自定義的起始時間
            tokens: 0,
            isHoldingButton: false,
            hasOptedOut: false,
            roundHoldDuration: 0,
        };

        // 初始化新的遊戲房間數據
        games[roomId] = {
            id: roomId,
            players: [newPlayer],
            status: 'waiting',
            currentRound: 0, // 初始回合數 (會在 startNewRound 中變成 1)
            maxRounds: maxRounds, // 使用自定義的總回合數
            preRoundCountdown: 0,
            preRoundIntervalId: null,
            roundElapsedTime: 0,
            roundTimerIntervalId: null,
            activePlayersInRound: [], // 追蹤活躍玩家
        };
        socket.join(roomId); // 將 socket 加入到房間
        socket.roomId = roomId; // 將房間 ID 儲存在 socket 物件上，方便後續使用

        console.log(`[CREATE_ROOM] 玩家 ${playerName} 創建了房間：${roomId} (起始時間: ${initialTime}, 回合數: ${maxRounds})`);
        callback({ success: true, roomId: roomId, player: newPlayer }); // 回傳成功訊息給前端

        // 創建房間後立即開始第一回合的準備 (這會觸發 roundEnded 事件更新前端回合數)
        startNewRound(roomId);
    });

    // 監聽加入房間事件
    socket.on('joinRoom', (roomId, playerName, callback) => {
        const game = games[roomId];
        if (!game) { // 房間不存在
            callback({ success: false, message: '房間不存在！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 房間不存在。`);
            return;
        }
        // 檢查遊戲狀態是否允許加入 (不能在 preCountdown 或 inRound 階段加入)
        if (game.status !== 'waiting' && game.status !== 'roundEnded' && game.status !== 'gameOver') {
            callback({ success: false, message: '遊戲已開始或無法加入！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 遊戲狀態為 ${game.status}。`);
            return;
        }
        if (game.players.length >= 4) { // 限制房間人數為 4 人
            callback({ success: false, message: '房間已滿！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 房間已滿。`);
            return;
        }
        // 檢查玩家名稱是否重複
        if (game.players.some(p => p.name === playerName)) {
            callback({ success: false, message: '此名稱已被使用！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 名稱重複。`);
            return;
        }

        const newPlayer = { // 創建新的玩家物件
            id: socket.id,
            name: playerName,
            time: game.players[0].time, // **重要：讓加入的玩家時間與房間創建者一致**
            tokens: 0,
            isHoldingButton: false,
            hasOptedOut: false,
            roundHoldDuration: 0,
        };
        game.players.push(newPlayer); // 將新玩家添加到遊戲房間
        socket.join(roomId); // 將 socket 加入房間
        socket.roomId = roomId; // 儲存房間 ID

        console.log(`[JOIN_ROOM] 玩家 ${playerName} 加入了房間：${roomId}`);
        callback({ success: true, roomId: roomId, player: newPlayer }); // 回傳成功訊息給前端

        broadcastPlayerStatusUpdate(roomId); // 廣播所有玩家狀態更新

        // 同步遊戲當前狀態的訊息給新加入的玩家
        if (game.status === 'preCountdown') {
            io.to(socket.id).emit('preRoundCountdownUpdate', game.preRoundCountdown);
            broadcastMessage(socket.id, `所有玩家已按住！倒數：${game.preRoundCountdown} 秒`);
        } else if (game.status === 'inRound') {
            io.to(socket.id).emit('roundStarting');
            io.to(socket.id).emit('roundTimerUpdate', game.roundElapsedTime);
            broadcastMessage(socket.id, '競標開始');
        } else if (game.status === 'roundEnded' || game.status === 'waiting') {
            broadcastMessage(socket.id, `第 ${game.currentRound} 回合：請所有玩家按住準備！`);
        }
    });

    // 監聽離開房間事件
    socket.on('leaveRoom', () => {
        const roomId = socket.roomId;
        if (roomId && games[roomId]) { // 確保玩家在一個有效房間內
            const game = games[roomId];
            const disconnectedPlayer = game.players.find(p => p.id === socket.id);
            game.players = game.players.filter(p => p.id !== socket.id); // 從玩家列表中移除
            delete socket.roomId; // 從 socket 物件中移除房間 ID

            if (game.players.length === 0) { // 如果房間已無玩家
                console.log(`[LEAVE_ROOM] 房間 ${roomId} 已清空，正在移除。`);
                clearGameIntervals(game); // 清除所有計時器
                delete games[roomId]; // 刪除遊戲數據
            } else { // 房間仍有玩家
                console.log(`[LEAVE_ROOM] 玩家 ${disconnectedPlayer ? disconnectedPlayer.name : socket.id} 離開了房間：${roomId}. Remaining players: ${game.players.length}`);
                // 如果在活躍狀態 (倒數或競標中) 且玩家不足 2 人，結束遊戲
                if ((game.status === 'preCountdown' || game.status === 'inRound') && game.players.length < 2) {
                    console.log(`[LEAVE_ROOM] Not enough players left in room ${roomId}. Ending game.`);
                    gameEnded(roomId, '玩家不足，遊戲結束！');
                }
                // 如果在倒數階段放手，且放手的玩家是正在按住的
                else if (game.status === 'preCountdown' && disconnectedPlayer && disconnectedPlayer.isHoldingButton && game.preRoundIntervalId) {
                    console.log(`[LEAVE_ROOM] Player disconnected during countdown.`);
                    clearInterval(game.preRoundIntervalId);
                    game.preRoundIntervalId = null;
                    game.status = 'waiting';
                    broadcastMessage(roomId, '有玩家斷開連接，倒數中斷。請所有玩家重新按住準備。');
                    const allPlayersHolding = game.players.length >= 2 && game.players.every(p => p.isHoldingButton);
                    if (allPlayersHolding) {
                        console.log(`[LEAVE_ROOM] Remaining players still holding, restarting countdown.`);
                        startPreRoundCountdown(roomId);
                    } else {
                        console.log(`[LEAVE_ROOM] Remaining players not enough or not holding. Starting new round.`);
                        setTimeout(() => startNewRound(roomId), 1000);
                    }
                }
                // 如果在競標階段放手，且放手的玩家是正在按住的
                else if (game.status === 'inRound' && disconnectedPlayer && disconnectedPlayer.isHoldingButton) {
                    console.log(`[LEAVE_ROOM] Player disconnected during bidding round. Checking all released.`);
                    checkAllReleasedOnServer(roomId);
                }
                broadcastPlayerStatusUpdate(roomId); // 廣播更新後的玩家狀態
            }
        } else {
            console.log(`[LEAVE_ROOM] Socket ${socket.id} tried to leave, but not associated with a room or room does not exist.`);
        }
    });

    // 監聽玩家按住按鈕事件
    socket.on('playerHolding', () => {
        const roomId = socket.roomId;
        if (!roomId || !games[roomId]) {
            console.log(`[HOLD] Error: Player ${socket.id} not in a valid room or room does not exist.`);
            return;
        }

        const game = games[roomId];
        const player = game.players.find(p => p.id === socket.id);

        if (player) {
            if (player.time <= 0) { // 時間用盡不能按住
                broadcastMessage(socket.id, `你的時間已用盡，無法按住！`);
                console.log(`[HOLD] Player ${player.name} time ran out, cannot hold.`);
                return;
            }

            if (!player.isHoldingButton) { // 只有在未按住狀態下才能按住
                player.isHoldingButton = true;
                broadcastPlayerStatusUpdate(roomId); // 更新前端顯示
                console.log(`[HOLD] 玩家 ${player.name} 在房間 ${roomId} 按住了按鈕。`);

                // 檢查是否可以開始倒數 (僅在 'waiting' 或 'roundEnded' 狀態)
                if (game.status === 'waiting' || game.status === 'roundEnded') {
                    const allPlayersHolding = game.players.every(p => p.isHoldingButton);
                    const playerCount = game.players.length;

                    const isSinglePlayerTest = playerCount === 1;

                    if (isSinglePlayerTest) { // 單人模式
                        if (allPlayersHolding && !game.preRoundIntervalId) {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Single player mode: All holding (${allPlayersHolding}), No current countdown. Attempting to start countdown.`);
                            startPreRoundCountdown(roomId);
                        } else {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Single player mode: Conditions not met. All Holding: ${allPlayersHolding}, Pre-round interval ID: ${game.preRoundIntervalId}`);
                        }
                    } else { // 多人模式 (至少2人)
                        if (playerCount >= 2 && allPlayersHolding && !game.preRoundIntervalId) {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Multi-player mode: Player Count >= 2 (${playerCount >= 2}), All Holding (${allPlayersHolding}), No current countdown. Attempting to start countdown.`);
                            startPreRoundCountdown(roomId);
                        } else {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Multi-player mode: Conditions not met. Player Count: ${playerCount}, All Holding: ${allPlayersHolding}, Pre-round interval ID: ${game.preRoundIntervalId}`);
                        }
                    }
                } else {
                    console.log(`[HOLD_CHECK_COUNTDOWN] Game status (${game.status}) not 'waiting' or 'roundEnded'. Not attempting to start countdown.`);
                }
            } else {
                console.log(`[HOLD] 玩家 ${player.name} 已經按住了按鈕。`);
            }
        } else {
            console.log(`[HOLD] 玩家 ${socket.id} 在房間 ${roomId} 中未找到。`);
        }
    });

    // 監聽玩家放開按鈕事件
    socket.on('playerReleased', () => {
        const roomId = socket.roomId;
        if (!roomId || !games[roomId]) {
            console.log(`[RELEASE] Error: Player ${socket.id} not in a valid room or room does not exist.`);
            return;
        }

        const game = games[roomId];
        const player = game.players.find(p => p.id === socket.id);

        if (player && player.isHoldingButton) { // 確保玩家確實是按住狀態才處理放開
            player.isHoldingButton = false;

            // 處理在倒數階段放手的情況
            if (game.status === 'preCountdown' && game.preRoundIntervalId) {
                clearInterval(game.preRoundIntervalId);
                game.preRoundIntervalId = null;
                game.status = 'waiting'; // 重置狀態為等待

                const anyPlayerStillHolding = game.players.some(p => p.isHoldingButton); // 檢查是否還有其他玩家按住

                if (!anyPlayerStillHolding) {
                    // 如果所有玩家都放手了 (包括剛放手的這個玩家)
                    broadcastMessage(roomId, `所有玩家都已放手，本回合無人參與。`);
                    console.log(`[RELEASE] All players released during countdown for room ${roomId}. No one participated.`);
                    game.players.forEach(p => p.hasOptedOut = false); // 清除本次 round 的 optOut 狀態
                    broadcastPlayerStatusUpdate(roomId); // 更新前端狀態
                    setTimeout(() => startNewRound(roomId), 2000); // 延遲後開始新回合
                } else {
                    // 還有其他玩家按住，但倒數中斷了
                    player.hasOptedOut = true; // 剛放手的玩家標記為退出
                    broadcastPlayerStatusUpdate(roomId);
                    broadcastMessage(roomId, `${player.name} 放手了，本回合倒數中斷。等待其他玩家按住...`);
                    console.log(`[RELEASE] Player ${player.name} released during countdown. Other players may still be holding.`);

                    // 給其他玩家一些時間重新按住，或者再次觸發倒數
                    setTimeout(() => {
                        const playersStillInGame = game.players.filter(p => !p.hasOptedOut);
                        // 對於多人遊戲，需要至少2個未退出且都按住才能重新開始倒數
                        const allRemainingHoldingAndEnough = playersStillInGame.length >= 2 && playersStillInGame.every(p => p.isHoldingButton);
                        const isSinglePlayerTest = game.players.length === 1;

                        if (isSinglePlayerTest && playersStillInGame.length === 1 && playersStillInGame[0].isHoldingButton) {
                            // 單人模式下如果只剩自己且還按著，直接開始競標 (這會導致其成為贏家)
                            const singleWinner = playersStillInGame[0];
                            broadcastMessage(roomId, `只剩 ${singleWinner.name} 按住。本回合將直接開始競標！`);
                            console.log(`[RELEASE] Single player ${singleWinner.name} left holding. Proceeding to bid.`);
                            singleWinner.roundHoldDuration = 0; // 重置本回合按住時間
                            game.activePlayersInRound = [singleWinner]; // 確保 activePlayersInRound 只有他
                            endRoundOnServer(roomId); // 直接結束回合，他將是贏家
                        } else if (allRemainingHoldingAndEnough) { // 如果剩餘玩家足夠且都按住了
                            console.log(`[RELEASE] Remaining players still holding, restarting countdown.`);
                            startPreRoundCountdown(roomId); // 重新開始倒數
                        } else {
                            // 剩餘玩家不足，或者沒有都按住，返回初始狀態並開始新回合
                            game.players.forEach(p => p.hasOptedOut = false); // 清除退出標記
                            broadcastPlayerStatusUpdate(roomId);
                            broadcastMessage(roomId, '倒數已中斷。請所有玩家重新按住準備。');
                            console.log(`[RELEASE] Countdown interrupted, not enough players or not all holding. Starting new round.`);
                            setTimeout(() => startNewRound(roomId), 1000);
                        }
                    }, 1500); // 1.5秒後再次檢查
                }
                return; // 處理完畢，退出函數
            }

            // 處理在競標階段放手的情況 (狀態為 'inRound')
            broadcastPlayerStatusUpdate(roomId); // 廣播玩家狀態更新

            if (game.status === 'inRound') {
                console.log(`[RELEASE] Player ${player.name} released during bidding round.`);
                checkAllReleasedOnServer(roomId); // 檢查是否所有玩家都放手
            } else {
                console.log(`[RELEASE] Player ${player.name} released in status ${game.status}. No special action.`);
            }
        } else {
            console.log(`[RELEASE] Player ${socket.id} was not holding button or not found.`);
        }
    });

    // 處理客戶端斷開連接 (無論是瀏覽器關閉還是主動離開)
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] 用戶斷開連接。Socket ID: ${socket.id}`);
        const roomId = socket.roomId; // 從 socket 屬性中獲取房間 ID
        if (roomId && games[roomId]) {
            const game = games[roomId];
            const disconnectedPlayer = game.players.find(p => p.id === socket.id);
            game.players = game.players.filter(p => p.id !== socket.id); // 從玩家列表中移除
            delete socket.roomId; // 清理 socket 上的 roomId 屬性

            if (game.players.length === 0) { // 如果房間已無玩家
                console.log(`[DISCONNECT] 房間 ${roomId} 已清空，正在移除。`);
                clearGameIntervals(game); // 清理所有計時器
                delete games[roomId]; // 刪除遊戲數據
            } else { // 房間仍有玩家
                console.log(`[DISCONNECT] 玩家 ${disconnectedPlayer ? disconnectedPlayer.name : socket.id} 離開了房間：${roomId}. Remaining players: ${game.players.length}`);
                // 如果在活躍狀態 (倒數或競標中) 且玩家不足 2 人，結束遊戲
                if ((game.status === 'preCountdown' || game.status === 'inRound') && game.players.length < 2) {
                    console.log(`[DISCONNECT] Not enough players left in room ${roomId}. Ending game.`);
                    gameEnded(roomId, '玩家不足，遊戲結束！');
                }
                // 如果在倒數階段斷開連接 (且該玩家當時正在按住)
                else if (game.status === 'preCountdown' && disconnectedPlayer && disconnectedPlayer.isHoldingButton && game.preRoundIntervalId) {
                    console.log(`[DISCONNECT] Player disconnected during countdown.`);
                    clearInterval(game.preRoundIntervalId);
                    game.preRoundIntervalId = null;
                    game.status = 'waiting';
                    broadcastMessage(roomId, '有玩家斷開連接，倒數中斷。請所有玩家重新按住準備。');
                    const allPlayersHolding = game.players.length >= 2 && game.players.every(p => p.isHoldingButton);
                    if (allPlayersHolding) {
                        console.log(`[DISCONNECT] Remaining players still holding, restarting countdown.`);
                        startPreRoundCountdown(roomId);
                    } else {
                        console.log(`[DISCONNECT] Remaining players not enough or not holding. Starting new round.`);
                        setTimeout(() => startNewRound(roomId), 1000);
                    }
                }
                // 如果在競標階段斷開連接 (且該玩家當時正在按住)
                else if (game.status === 'inRound' && disconnectedPlayer && disconnectedPlayer.isHoldingButton) {
                    console.log(`[DISCONNECT] Player disconnected during bidding round. Checking all released.`);
                    checkAllReleasedOnServer(roomId);
                }
                broadcastPlayerStatusUpdate(roomId); // 廣播更新後的玩家狀態
            }
        } else {
            console.log(`[DISCONNECT] Socket ${socket.id} disconnected, but not associated with a room.`);
        }
    });
});

// 啟動伺服器並監聽指定端口
server.listen(PORT, () => {
    console.log(`伺服器運行在 http://localhost:${PORT}`);
});