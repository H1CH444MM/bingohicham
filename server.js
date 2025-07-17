const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Configuration
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Structure des données
const games = new Map();
const players = new Map();

// Génération d'un code de partie aléatoire
function generateGameCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Génération d'une grille de bingo
function generateBingoGrid() {
    const grid = [];
    const usedNumbers = new Set();
    
    for (let i = 0; i < 25; i++) {
        let num;
        do {
            num = Math.floor(Math.random() * 75) + 1;
        } while (usedNumbers.has(num));
        
        usedNumbers.add(num);
        grid.push({
            number: i === 12 ? 'FREE' : num, // Case centrale gratuite
            marked: i === 12
        });
    }
    
    return grid;
}

// Génération des numéros pour le tirage
function generateDrawNumbers() {
    const numbers = [];
    for (let i = 1; i <= 75; i++) {
        numbers.push(i);
    }
    return numbers.sort(() => Math.random() - 0.5);
}

// Vérification du bingo
function checkBingo(grid) {
    const winningPatterns = [
        // Lignes horizontales
        [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
        [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
        // Colonnes verticales
        [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22],
        [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
        // Diagonales
        [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]
    ];
    
    return winningPatterns.some(pattern => 
        pattern.every(index => grid[index].marked)
    );
}

// Routes API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/create-game', (req, res) => {
    const gameCode = generateGameCode();
    const game = {
        code: gameCode,
        players: new Map(),
        status: 'waiting', // waiting, playing, finished
        drawnNumbers: [],
        availableNumbers: generateDrawNumbers(),
        currentNumber: null,
        winner: null,
        createdAt: new Date()
    };
    
    games.set(gameCode, game);
    res.json({ success: true, gameCode });
});

app.post('/api/join-game', (req, res) => {
    const { gameCode } = req.body;
    const game = games.get(gameCode);
    
    if (!game) {
        return res.json({ success: false, error: 'Partie non trouvée' });
    }
    
    if (game.status !== 'waiting') {
        return res.json({ success: false, error: 'Partie déjà commencée' });
    }
    
    res.json({ success: true });
});

// Gestion des connexions Socket.IO
io.on('connection', (socket) => {
    console.log('Nouvel utilisateur connecté:', socket.id);
    
    socket.on('join-game', ({ gameCode, playerName }) => {
        const game = games.get(gameCode);
        
        if (!game) {
            socket.emit('error', 'Partie non trouvée');
            return;
        }
        
        if (game.status !== 'waiting') {
            socket.emit('error', 'Partie déjà commencée');
            return;
        }
        
        // Ajouter le joueur à la partie
        const player = {
            id: socket.id,
            name: playerName,
            grid: generateBingoGrid(),
            hasBingo: false
        };
        
        game.players.set(socket.id, player);
        players.set(socket.id, { gameCode, playerName });
        
        socket.join(gameCode);
        
        // Informer tous les joueurs
        socket.emit('game-joined', {
            gameCode,
            player,
            players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
        });
        
        socket.to(gameCode).emit('player-joined', {
            player: { id: player.id, name: player.name },
            players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
        });
    });
    
    socket.on('start-game', ({ gameCode }) => {
        const game = games.get(gameCode);
        
        if (!game || game.players.size < 2) {
            socket.emit('error', 'Au moins 2 joueurs requis');
            return;
        }
        
        game.status = 'playing';
        io.to(gameCode).emit('game-started');
        
        // Commencer le tirage automatique
        startAutoDraw(gameCode);
    });
    
    socket.on('mark-number', ({ gameCode, index }) => {
        const game = games.get(gameCode);
        const player = game?.players.get(socket.id);
        
        if (!game || !player || game.status !== 'playing') return;
        
        const cell = player.grid[index];
        if (cell.number === 'FREE') return;
        
        // Vérifier si le numéro a été tiré
        if (game.drawnNumbers.includes(cell.number)) {
            cell.marked = !cell.marked;
            
            // Vérifier le bingo
            if (checkBingo(player.grid)) {
                player.hasBingo = true;
                game.status = 'finished';
                game.winner = player;
                
                io.to(gameCode).emit('bingo', {
                    winner: { id: player.id, name: player.name },
                    winningGrid: player.grid
                });
            }
            
            socket.emit('grid-updated', player.grid);
        }
    });
    
    socket.on('chat-message', ({ gameCode, message }) => {
        const game = games.get(gameCode);
        const player = game?.players.get(socket.id);
        
        if (!game || !player || !message.trim()) return;
        
        const chatMessage = {
            playerId: socket.id,
            playerName: player.name,
            message: message.trim(),
            timestamp: new Date()
        };
        
        io.to(gameCode).emit('chat-message', chatMessage);
    });
    
    socket.on('restart-game', ({ gameCode }) => {
        const game = games.get(gameCode);
        
        if (!game) return;
        
        // Réinitialiser le jeu
        game.status = 'waiting';
        game.drawnNumbers = [];
        game.availableNumbers = generateDrawNumbers();
        game.currentNumber = null;
        game.winner = null;
        
        // Générer de nouvelles grilles pour tous les joueurs
        game.players.forEach(player => {
            player.grid = generateBingoGrid();
            player.hasBingo = false;
        });
        
        io.to(gameCode).emit('game-restarted', {
            players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
        });
    });
    
    socket.on('disconnect', () => {
        const playerData = players.get(socket.id);
        if (playerData) {
            const { gameCode } = playerData;
            const game = games.get(gameCode);
            
            if (game) {
                game.players.delete(socket.id);
                socket.to(gameCode).emit('player-left', {
                    playerId: socket.id,
                    players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
                });
                
                // Supprimer la partie si elle est vide
                if (game.players.size === 0) {
                    games.delete(gameCode);
                }
            }
            
            players.delete(socket.id);
        }
    });
});

// Fonction pour le tirage automatique
function startAutoDraw(gameCode) {
    const game = games.get(gameCode);
    if (!game || game.status !== 'playing') return;
    
    const drawInterval = setInterval(() => {
        if (game.status !== 'playing' || game.availableNumbers.length === 0) {
            clearInterval(drawInterval);
            return;
        }
        
        const number = game.availableNumbers.pop();
        game.drawnNumbers.push(number);
        game.currentNumber = number;
        
        io.to(gameCode).emit('number-drawn', {
            number,
            drawnNumbers: game.drawnNumbers
        });
            }, 5000); // Tirage toutes les 5 secondes
}

// Nettoyage des parties anciennes
setInterval(() => {
    const now = new Date();
    for (const [code, game] of games.entries()) {
        if (now - game.createdAt > 24 * 60 * 60 * 1000) { // 24 heures
            games.delete(code);
        }
    }
}, 60 * 60 * 1000); // Vérification toutes les heures

server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
