// time-auction-server/index.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

const games = {};

// --- 幫助函數 ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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

function broadcastPlayerStatusUpdate(roomId) {
    const game = games[roomId];
    if (game) {
        io.to(roomId).emit('playerStatusUpdate', {
            players: game.players,
            currentRound: game.currentRound,
            maxRounds: game.maxRounds,
            gameStatus: game.status
        });
    }
}

function broadcastMessage(roomId, messageText) {
    io.to(roomId).emit('message', messageText);
}

// --- 遊戲流程函數 (由後端控制主要遊戲邏輯) ---

// 開始新回合的準備階段
function startNewRound(roomId) {
    const game = games[roomId];
    if (!game) return;

    console.log(`[GAME_FLOW] Starting new round for room ${roomId}. Current round: ${game.currentRound}, Max rounds: ${game.maxRounds}`);

    // 過濾出未淘汰的玩家
    const alivePlayers = game.players.filter(p => !p.isEliminated);

    // **新增判斷：如果只剩一個玩家未淘汰，則遊戲結束**
    if (alivePlayers.length <= 1 && game.currentRound > 0) { // 如果只剩一人或無人，且已不是第0回合
        console.log(`[GAME_FLOW] Room ${roomId}: Only ${alivePlayers.length} player(s) left. Ending game.`);
        gameEnded(roomId, alivePlayers.length === 1 ? `${alivePlayers[0].name} 是唯一倖存者！遊戲結束。` : '所有玩家都被淘汰，遊戲結束。');
        return;
    }

    // **重要修改**：先檢查是否達到最大回合數來判斷遊戲結束
    if (game.currentRound >= game.maxRounds) {
        console.log(`[GAME_FLOW] Room ${roomId}: Reached max rounds (${game.maxRounds}). Ending game.`);
        gameEnded(roomId, '所有回合已結束。'); // 觸發遊戲結束，並提供原因
        return;
    }

    game.currentRound++; // 遞增回合數

    game.preRoundCountdown = 0;
    game.roundElapsedTime = 0;
    game.status = 'waiting';

    game.players.forEach(p => {
        p.isHoldingButton = false;
        p.hasOptedOut = false;
        p.roundHoldDuration = 0;
    });

    broadcastPlayerStatusUpdate(roomId);
    broadcastMessage(roomId, `第 ${game.currentRound} 回合：請所有玩家按住準備！`);

    io.to(roomId).emit('roundEnded', {
        message: `第 ${game.currentRound} 回合：請所有玩家按住準備！`,
        updatedPlayers: game.players,
        currentRound: game.currentRound,
        maxRounds: game.maxRounds,
    });
    console.log(`[GAME_FLOW] Round ${game.currentRound} for room ${roomId} started. Status: ${game.status}`);

    if (game.currentRound > 0 && game.currentRound % 3 === 0 && game.currentRound !== game.maxRounds) {
        io.to(roomId).emit('showRoundStatsModal');
        console.log(`[GAME_FLOW] Room ${roomId}: Triggered Round Stats Modal for Round ${game.currentRound}`);
    }
}


function startPreRoundCountdown(roomId) {
    const game = games[roomId];
    console.log(`[START_COUNTDOWN_FN] Attempting to start countdown for room ${roomId}. Current status: ${game ? game.status : 'N/A'}`);
    if (!game || game.status === 'preCountdown' || game.status === 'inRound') {
        console.log(`[START_COUNTDOWN_FN] Aborting: Game not found or already in countdown/round. Status: ${game ? game.status : 'N/A'}`);
        return;
    }

    // 只考慮未淘汰的玩家來判斷是否所有人都按住了
    const alivePlayers = game.players.filter(p => !p.isEliminated);
    const playerCount = alivePlayers.length;
    const allPlayersHolding = alivePlayers.every(p => p.isHoldingButton);

    console.log(`[START_COUNTDOWN_FN] Inside conditions check: Alive Players: ${playerCount}, All Holding: ${allPlayersHolding}`);

    let shouldStartCountdown = false;
    // 單人測試模式: 如果是單人且未被淘汰，只要他按住就啟動
    if (playerCount === 1) {
        if (allPlayersHolding) {
            shouldStartCountdown = true;
        }
    } else { // 正常多人遊戲模式: 至少2人未淘汰且所有未淘汰玩家都按住
        if (playerCount >= 2 && allPlayersHolding) {
            shouldStartCountdown = true;
        }
    }

    if (!shouldStartCountdown) {
        console.log(`[START_COUNTDOWN_FN] Conditions ultimately not met. Should Start Countdown: ${shouldStartCountdown}. Aborting countdown.`);
        return;
    }

    console.log(`[START_COUNTDOWN_FN] Countdown conditions MET for room ${roomId}. Starting countdown!`);

    game.status = 'preCountdown';
    game.preRoundCountdown = 5;
    game.players.forEach(p => { // 重置所有玩家，包括淘汰的
        p.hasOptedOut = false;
        p.roundHoldDuration = 0;
    });

    broadcastPlayerStatusUpdate(roomId);
    io.to(roomId).emit('preRoundCountdownUpdate', game.preRoundCountdown);
    broadcastMessage(roomId, `所有玩家已按住！倒數：${game.preRoundCountdown} 秒`);

    game.preRoundIntervalId = setInterval(() => {
        game.preRoundCountdown--;
        io.to(roomId).emit('preRoundCountdownUpdate', game.preRoundCountdown);
        console.log(`[COUNTDOWN] Room ${roomId} countdown: ${game.preRoundCountdown}`);

        if (game.preRoundCountdown <= 0) {
            clearInterval(game.preRoundIntervalId);
            game.preRoundIntervalId = null;
            console.log(`[COUNTDOWN] Room ${roomId} countdown finished.`);
            handlePreRoundEndOnServer(roomId);
        }
    }, 1000);
}

function handlePreRoundEndOnServer(roomId) {
    const game = games[roomId];
    if (!game) return;

    console.log(`[HANDLE_PRE_ROUND_END] Room ${roomId}: Pre-round countdown ended. Status: ${game.status}`);

    game.players.forEach(p => {
        // 如果玩家時間用盡，且沒有明確選擇退出，則標記為退出和淘汰
        if (p.time <= 0 && !p.hasOptedOut && !p.isEliminated) { // **新增：檢查是否已被淘汰**
            p.hasOptedOut = true;
            p.isEliminated = true; // **重要：標記為永久淘汰**
            broadcastMessage(roomId, `${p.name} 時間已用盡，已被淘汰！`);
            console.log(`[HANDLE_PRE_ROUND_END] Player ${p.name} time ran out and eliminated.`);
        }
        // 如果玩家在倒數結束時沒有按住按鈕，且未被淘汰，則標記為退出
        else if (!p.isHoldingButton && !p.hasOptedOut && !p.isEliminated) { // **新增：檢查是否已被淘汰**
            p.hasOptedOut = true;
            console.log(`[HANDLE_PRE_ROUND_END] Player ${p.name} opted out (not holding after countdown).`);
        }
    });

    // 過濾出本回合真正參與競標的玩家 (按住按鈕且未被淘汰和未放棄的)
    game.activePlayersInRound = game.players.filter(p => p.isHoldingButton && !p.hasOptedOut && !p.isEliminated);
    console.log(`[HANDLE_PRE_ROUND_END] Active players for this round: ${game.activePlayersInRound.map(p => p.name).join(', ')}`);

    // **新增判斷：如果 activePlayersInRound 不足 1 人，則直接結束本輪，進入新回合準備**
    if (game.activePlayersInRound.length < 1) {
        broadcastMessage(roomId, '倒數結束，無人堅持競標。本回合無人獲勝。');
        console.log(`[HANDLE_PRE_ROUND_END] No active players after countdown for room ${roomId}.`);
        setTimeout(() => startNewRound(roomId), 2000);
        return;
    }

    game.status = 'inRound';
    game.roundElapsedTime = 0;

    broadcastMessage(roomId, '競標開始！堅持住！');
    io.to(roomId).emit('roundStarting');
    console.log(`[HANDLE_PRE_ROUND_END] Round for room ${roomId} is starting!`);

    game.roundTimerIntervalId = setInterval(() => {
        game.roundElapsedTime++;

        let somePlayerStatusChanged = false; // 用於檢查是否有玩家狀態變化需要廣播
        game.players.forEach(p => {
            // 只有未淘汰且正在按住的玩家才增加 roundHoldDuration
            if (p.isHoldingButton && !p.hasOptedOut && !p.isEliminated) { // **新增：檢查未淘汰**
                p.roundHoldDuration++;
                // 檢查玩家時間是否用盡
                if (p.time - p.roundHoldDuration <= 0) {
                    p.isHoldingButton = false;
                    p.roundHoldDuration = p.time;
                    p.hasOptedOut = true;
                    p.isEliminated = true; // **重要：標記為永久淘汰**
                    broadcastMessage(roomId, `${p.name} 的時間用盡了！已被淘汰！`);
                    console.log(`[IN_ROUND] Player ${p.name} time ran out and eliminated.`);
                    somePlayerStatusChanged = true;
                }
            }
        });
        if (somePlayerStatusChanged) {
            broadcastPlayerStatusUpdate(roomId);
        }

        io.to(roomId).emit('roundTimerUpdate', game.roundElapsedTime);

        checkAllReleasedOnServer(roomId);

    }, 1000);
}

function checkAllReleasedOnServer(roomId) {
    const game = games[roomId];
    if (!game || game.status !== 'inRound') return;

    // 檢查所有「活躍」玩家 (進入競標且未被淘汰) 是否都已放手或已放棄
    const allActiveReleased = game.activePlayersInRound.every(p => {
        const currentPlayerState = game.players.find(gp => gp.id === p.id);
        // 如果玩家不存在、或玩家已放手、或玩家已因為時間耗盡而放棄、或玩家已被淘汰
        return !currentPlayerState || (!currentPlayerState.isHoldingButton || currentPlayerState.hasOptedOut || currentPlayerState.isEliminated);
    });

    if (allActiveReleased) {
        console.log(`[CHECK_RELEASED] All active players in room ${roomId} have released.`);
        clearGameIntervals(game);
        endRoundOnServer(roomId);
    }
}

function endRoundOnServer(roomId) {
    const game = games[roomId];
    if (!game) return;

    game.status = 'roundEnded';

    let winner = null;
    let maxHoldDuration = 0;
    let winningPlayers = [];

    // 找出 activePlayersInRound 中，roundHoldDuration 最高的玩家。
    game.activePlayersInRound.forEach(p => {
        // 只考慮未淘汰且未放棄的玩家
        if (!p.isEliminated && !p.hasOptedOut) {
            if (p.roundHoldDuration > maxHoldDuration) {
                maxHoldDuration = p.roundHoldDuration;
                winningPlayers = [p];
            } else if (p.roundHoldDuration === maxHoldDuration) {
                winningPlayers.push(p);
            }
        }
    });
    console.log(`[END_ROUND] Room ${roomId}: Max hold duration: ${maxHoldDuration}, Winning Players count: ${winningPlayers.length}`);

    let winnerAnnouncementMessage = '';

    if (maxHoldDuration === 0 || winningPlayers.length === 0) {
        winnerAnnouncementMessage = '本回合無人參與。';
        broadcastMessage(roomId, winnerAnnouncementMessage);
        console.log(`[END_ROUND] Room ${roomId}: No winner.`);
    } else {
        if (winningPlayers.length === 1) {
            winner = winningPlayers[0];
            winner.tokens += 1;
            winner.time -= maxHoldDuration; // 贏家扣除時間
            winnerAnnouncementMessage = `${winner.name} 贏得了本回合！`; // 移除「堅持了X秒」
            broadcastMessage(roomId, winnerAnnouncementMessage);
            console.log(`[END_ROUND] Room ${roomId}: Winner: ${winner.name}`);
        } else {
            const winnerNames = winningPlayers.map(p => p.name).join(' 和 ');
            winningPlayers.forEach(p => {
                p.tokens += 1;
                p.time -= maxHoldDuration; // 平手贏家也扣除時間
            });
            winnerAnnouncementMessage = `本回合平手！贏家有 ${winnerNames}！`; // 移除「堅持了X秒」
            broadcastMessage(roomId, winnerAnnouncementMessage);
            console.log(`[END_ROUND] Room ${roomId}: Tie winners: ${winnerNames}`);
        }
    }

    io.to(roomId).emit('roundWinnerAnnounced', {
        message: winnerAnnouncementMessage,
        winners: winningPlayers.map(p => ({ id: p.id, name: p.name })),
        duration: maxHoldDuration,
        isTie: winningPlayers.length > 1
    });

    game.players.forEach(p => {
        p.isHoldingButton = false;
        p.hasOptedOut = false;
        // p.roundHoldDuration = 0; // 不在這裡重置，在 startNewRound 統一重置
    });

    broadcastPlayerStatusUpdate(roomId);

    // 遊戲結束判斷現在只在 startNewRound 開頭 和 玩家不足時進行
    setTimeout(() => {
        startNewRound(roomId); // 無論如何都嘗試開始新回合，由 startNewRound 內部判斷是否該結束遊戲
    }, 3000);
}

function gameEnded(roomId, reason) {
    const game = games[roomId];
    if (!game) return;

    game.status = 'gameOver';
    clearGameIntervals(game);

    let finalWinner = null;
    const alivePlayers = game.players.filter(p => !p.isEliminated); // 只考慮未淘汰的玩家來排序

    // 最終優勝者判斷邏輯
    if (alivePlayers.length > 0) {
        const sortedPlayers = [...alivePlayers].sort((a, b) => {
            if (b.tokens !== a.tokens) {
                return b.tokens - a.tokens;
            }
            return b.time - a.time;
        });

        const topPlayer = sortedPlayers[0];
        const coWinners = sortedPlayers.filter(p => p.tokens === topPlayer.tokens && p.time === topPlayer.time);

        if (coWinners.length > 1) {
            finalWinner = {
                isTie: true,
                names: coWinners.map(p => p.name).join(' 和 '),
                players: coWinners.map(p => ({ id: p.id, name: p.name, tokens: p.tokens, time: p.time }))
            };
        } else {
            finalWinner = {
                isTie: false,
                name: topPlayer.name,
                id: topPlayer.id,
                tokens: topPlayer.tokens,
                time: topPlayer.time
            };
        }
    } else {
        // 如果所有玩家都被淘汰，則沒有最終優勝者
        finalWinner = { isTie: false, name: '無人', id: null, tokens: 0, time: 0 };
        reason = reason || '所有玩家都被淘汰，遊戲結束。';
    }


    io.to(roomId).emit('gameOver', {
        reason: reason,
        finalPlayers: game.players, // 發送所有玩家（包括已淘汰的）的最終數據
        finalWinner: finalWinner
    });
    console.log(`[GAME_OVER] Room ${roomId} game ended: ${reason}`);
    console.log(`[GAME_OVER] Final Players:`, game.players.map(p => `${p.name} (Tokens: ${p.tokens}, Time: ${p.time}, Eliminated: ${p.isEliminated})`));
    console.log(`[GAME_OVER] Final Winner:`, finalWinner);
}


// --- Socket.IO 連接事件處理 ---
io.on('connection', (socket) => {
    console.log(`[CONNECT] 一位用戶連接了！Socket ID: ${socket.id}`);

    socket.on('createRoom', (data, callback) => {
        const { playerName, initialTime, maxRounds } = data;

        if (typeof initialTime !== 'number' || initialTime < 10 || initialTime > 600 || isNaN(initialTime)) {
            callback({ success: false, message: '無效的起始時間 (10-600 秒)。' });
            return;
        }
        if (typeof maxRounds !== 'number' || maxRounds < 1 || maxRounds > 50 || isNaN(maxRounds)) {
            callback({ success: false, message: '無效的遊戲回合數 (1-50 回合)。' });
            return;
        }

        const roomId = generateRoomId();
        const newPlayer = {
            id: socket.id,
            name: playerName,
            time: initialTime,
            tokens: 0,
            isHoldingButton: false,
            hasOptedOut: false,
            roundHoldDuration: 0,
            isEliminated: false, // **新增：初始狀態未被淘汰**
        };

        games[roomId] = {
            id: roomId,
            players: [newPlayer],
            status: 'waiting',
            currentRound: 0,
            maxRounds: maxRounds,
            preRoundCountdown: 0,
            preRoundIntervalId: null,
            roundElapsedTime: 0,
            roundTimerIntervalId: null,
            activePlayersInRound: [],
        };
        socket.join(roomId);
        socket.roomId = roomId;

        console.log(`[CREATE_ROOM] 玩家 ${playerName} 創建了房間：${roomId} (起始時間: ${initialTime}, 回合數: ${maxRounds})`);
        callback({ success: true, roomId: roomId, player: newPlayer });

        startNewRound(roomId);
    });

    socket.on('joinRoom', (roomId, playerName, callback) => {
        const game = games[roomId];
        if (!game) {
            callback({ success: false, message: '房間不存在！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 房間不存在。`);
            return;
        }
        if (game.status !== 'waiting' && game.status !== 'roundEnded' && game.status !== 'gameOver') {
            callback({ success: false, message: '遊戲已開始或無法加入！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 遊戲狀態為 ${game.status}。`);
            return;
        }
        if (game.players.length >= 4) {
            callback({ success: false, message: '房間已滿！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 房間已滿。`);
            return;
        }
        if (game.players.some(p => p.name === playerName)) {
            callback({ success: false, message: '此名稱已被使用！' });
            console.log(`[JOIN_ROOM] 玩家 ${playerName} 嘗試加入房間 ${roomId} 失敗: 名稱重複。`);
            return;
        }

        const newPlayer = {
            id: socket.id,
            name: playerName,
            time: game.players[0].time,
            tokens: 0,
            isHoldingButton: false,
            hasOptedOut: false,
            roundHoldDuration: 0,
            isEliminated: false, // **新增：初始狀態未被淘汰**
        };
        game.players.push(newPlayer);
        socket.join(roomId);
        socket.roomId = roomId;

        console.log(`[JOIN_ROOM] 玩家 ${playerName} 加入了房間：${roomId}`);
        callback({ success: true, roomId: roomId, player: newPlayer });

        broadcastPlayerStatusUpdate(roomId);
        if (game.status === 'preCountdown') {
            io.to(socket.id).emit('preRoundCountdownUpdate', game.preRoundCountdown);
            broadcastMessage(socket.id, `所有玩家已按住！倒數：${game.preRoundCountdown} 秒`);
        } else if (game.status === 'inRound') {
            io.to(socket.id).emit('roundStarting');
            io.to(socket.id).emit('roundTimerUpdate', game.roundElapsedTime);
            broadcastMessage(socket.id, '競標開始！堅持住！');
        } else if (game.status === 'roundEnded' || game.status === 'waiting' || game.status === 'gameOver') { // 如果遊戲結束，新玩家也可以看到分數
            broadcastMessage(socket.id, `第 ${game.currentRound} 回合：請所有玩家按住準備！`);
            // 如果遊戲已結束，還要同步 finalPlayers 和 finalWinner
            if (game.status === 'gameOver') {
                io.to(socket.id).emit('gameOver', {
                    reason: game.gameOverReason, // 假設在 gameEnded 中會儲存 reason
                    finalPlayers: game.players,
                    finalWinner: game.finalWinner,
                });
            }
        }
    });

    socket.on('leaveRoom', () => {
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            const disconnectedPlayer = game.players.find(p => p.id === socket.id);
            game.players = game.players.filter(p => p.id !== socket.id);
            delete socket.roomId;

            if (game.players.length === 0) {
                console.log(`[LEAVE_ROOM] 房間 ${roomId} 已清空，正在移除。`);
                clearGameIntervals(game);
                delete games[roomId];
            } else {
                console.log(`[LEAVE_ROOM] 玩家 ${disconnectedPlayer ? disconnectedPlayer.name : socket.id} 離開了房間：${roomId}. Remaining players: ${game.players.length}`);

                const alivePlayersCount = game.players.filter(p => !p.isEliminated).length;

                if ((game.status === 'preCountdown' || game.status === 'inRound') && alivePlayersCount < 2) { // 只有未淘汰玩家不足2個才結束遊戲
                    console.log(`[LEAVE_ROOM] Not enough ALIVE players left in room ${roomId}. Ending game.`);
                    gameEnded(roomId, '玩家不足，遊戲結束！');
                } else if (game.status === 'preCountdown' && disconnectedPlayer && disconnectedPlayer.isHoldingButton && game.preRoundIntervalId) {
                    clearInterval(game.preRoundIntervalId);
                    game.preRoundIntervalId = null;
                    game.status = 'waiting';
                    broadcastMessage(roomId, '有玩家斷開連接，倒數中斷。請所有玩家重新按住準備。');
                    const allAliveHolding = game.players.filter(p => !p.isEliminated).every(p => p.isHoldingButton);
                    if (allAliveHolding) { // 只有未淘汰玩家都按住才重新開始倒數
                        console.log(`[LEAVE_ROOM] Remaining ALIVE players still holding, restarting countdown.`);
                        startPreRoundCountdown(roomId);
                    } else {
                        console.log(`[LEAVE_ROOM] Remaining ALIVE players not enough or not holding. Starting new round.`);
                        setTimeout(() => startNewRound(roomId), 1000);
                    }
                } else if (game.status === 'inRound' && disconnectedPlayer && disconnectedPlayer.isHoldingButton) {
                    checkAllReleasedOnServer(roomId);
                }
                broadcastPlayerStatusUpdate(roomId);
            }
        } else {
            console.log(`[LEAVE_ROOM] Socket ${socket.id} tried to leave, but not associated with a room or room does not exist.`);
        }
    });

    socket.on('playerHolding', () => {
        const roomId = socket.roomId;
        if (!roomId || !games[roomId]) {
            console.log(`[HOLD] Error: Player ${socket.id} not in a valid room or room does not exist.`);
            return;
        }

        const game = games[roomId];
        const player = game.players.find(p => p.id === socket.id);

        if (player) {
            if (player.time <= 0 || player.isEliminated) { // **新增：已淘汰玩家無法按住**
                broadcastMessage(socket.id, `你已淘汰或時間用盡，無法按住！`);
                console.log(`[HOLD] Player ${player.name} is eliminated or time ran out, cannot hold.`);
                return;
            }

            if (!player.isHoldingButton) {
                player.isHoldingButton = true;
                broadcastPlayerStatusUpdate(roomId);
                console.log(`[HOLD] 玩家 ${player.name} 在房間 ${roomId} 按住了按鈕。`);

                console.log(`[HOLD_CHECK_COUNTDOWN] Room Status: ${game.status}`);
                const alivePlayers = game.players.filter(p => !p.isEliminated); // 只考慮未淘汰的玩家
                const playerCount = alivePlayers.length;
                const allPlayersHolding = alivePlayers.every(p => p.isHoldingButton); // 檢查所有未淘汰玩家是否按住

                console.log(`[HOLD_CHECK_COUNTDOWN] Alive Players in room: ${playerCount}`);
                console.log(`[HOLD_CHECK_COUNTDOWN] All ALIVE players holding? : ${allPlayersHolding}`);
                console.log(`[HOLD_CHECK_COUNTDOWN] Pre-round interval ID: ${game.preRoundIntervalId}`);

                if (game.status === 'waiting' || game.status === 'roundEnded') {
                    const isSinglePlayerTest = playerCount === 1; // 判斷是否為單人測試模式 (未淘汰玩家)

                    if (isSinglePlayerTest) {
                        if (allPlayersHolding && !game.preRoundIntervalId) {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Single ALIVE player mode: All holding (${allPlayersHolding}), No current countdown. Attempting to start countdown.`);
                            startPreRoundCountdown(roomId);
                        } else {
                            console.log(`[HOLD_CHECK_COUNTDOWN] Single ALIVE player mode: Conditions not met. All Holding: ${allPlayersHolding}, Pre-round interval ID: ${game.preRoundIntervalId}`);
                        }
                    } else {
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

    socket.on('playerReleased', () => {
        const roomId = socket.roomId;
        if (!roomId || !games[roomId]) {
            console.log(`[RELEASE] Error: Player ${socket.id} not in a valid room or room does not exist.`);
            return;
        }

        const game = games[roomId];
        const player = game.players.find(p => p.id === socket.id);

        if (player && player.isHoldingButton) {
            player.isHoldingButton = false;

            if (game.status === 'preCountdown' && game.preRoundIntervalId) {
                player.hasOptedOut = true;
                broadcastPlayerStatusUpdate(roomId);
                broadcastMessage(socket.id, `你已放棄本回合。`);
                console.log(`[RELEASE] Player ${player.name} opted out during countdown in room ${roomId}. Countdown continues.`);
                return;
            }

            broadcastPlayerStatusUpdate(roomId);

            if (game.status === 'inRound') {
                console.log(`[RELEASE] Player ${player.name} released during bidding round.`);
                checkAllReleasedOnServer(roomId);
            } else {
                console.log(`[RELEASE] Player ${player.name} released in status ${game.status}. No special action.`);
            }
        } else {
            console.log(`[RELEASE] Player ${player.name} was not holding button or not found.`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] 用戶斷開連接。Socket ID: ${socket.id}`);
        const roomId = socket.roomId;
        if (roomId && games[roomId]) {
            const game = games[roomId];
            const disconnectedPlayer = game.players.find(p => p.id === socket.id);
            game.players = game.players.filter(p => p.id !== socket.id);
            delete socket.roomId;

            if (game.players.length === 0) {
                console.log(`[DISCONNECT] 房間 ${roomId} 已清空，正在移除。`);
                clearGameIntervals(game);
                delete games[roomId];
            } else {
                console.log(`[DISCONNECT] 玩家 ${disconnectedPlayer ? disconnectedPlayer.name : socket.id} 離開了房間：${roomId}. Remaining players: ${game.players.length}`);

                const alivePlayers = game.players.filter(p => !p.isEliminated);
                const alivePlayersCount = alivePlayers.length;

                if ((game.status === 'preCountdown' || game.status === 'inRound') && alivePlayersCount < 2) {
                    console.log(`[DISCONNECT] Not enough ALIVE players left in room ${roomId}. Ending game.`);
                    gameEnded(roomId, '玩家不足，遊戲結束！');
                } else if (game.status === 'preCountdown' && disconnectedPlayer && disconnectedPlayer.isHoldingButton && game.preRoundIntervalId) {
                    clearInterval(game.preRoundIntervalId);
                    game.preRoundIntervalId = null;
                    game.status = 'waiting';
                    broadcastMessage(roomId, '有玩家斷開連接，倒數中斷。請所有玩家重新按住準備。');
                    const allAliveHolding = alivePlayers.every(p => p.isHoldingButton); // 只檢查未淘汰玩家
                    if (allAliveHolding) {
                        console.log(`[DISCONNECT] Remaining ALIVE players still holding, restarting countdown.`);
                        startPreRoundCountdown(roomId);
                    } else {
                        console.log(`[DISCONNECT] Remaining ALIVE players not enough or not holding. Starting new round.`);
                        setTimeout(() => startNewRound(roomId), 1000);
                    }
                } else if (game.status === 'inRound' && disconnectedPlayer && disconnectedPlayer.isHoldingButton) {
                    checkAllReleasedOnServer(roomId);
                }
                broadcastPlayerStatusUpdate(roomId);
            }
        } else {
            console.log(`[DISCONNECT] Socket ${socket.id} disconnected, but not associated with a room.`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`伺服器運行在 http://localhost:${PORT}`);
});