const app = require('express')()
const server = require('http').Server(app)
const appID = process.env.APPID
const bp = require('body-parser')
const redisClient = require('redis')
const io = require('socket.io')(server, {
  cors: {
    origin: "http://localhost:3006",
    methods: ["GET", "POST"],
    credentials: true
  }
})

//  CORS 
const cors = require('cors')
const corsOptions = {
  origin: ['http://localhost:3006', 'http://192.168.0.3:3006']
}
app.use(cors(corsOptions))
app.use(bp.json())
app.use(bp.urlencoded({ extended: true }))

const redisConfig = { host: "redis", port: 6379 }

// Adapter
const redis = require("socket.io-redis");
io.adapter(redis(redisConfig));

// Redis Clients
const subscriber = redisClient.createClient(redisConfig)
const publisher = redisClient.createClient(redisConfig)
const dbClient = redisClient.createClient(redisConfig)

// Function Constans
const port = 8080
const minRoomSize = 2
const updateInterval = 3000
// const maxRank = 100
// const rankInterval = 20

subscriber.subscribe('users')
subscriber.subscribe('queue')
subscriber.subscribe('create-room')
subscriber.subscribe('add-to-room')
subscriber.subscribe('socketIds')
subscriber.subscribe('accept-match')

let users = []
let queue = []
let socketIds = {}
let rooms = {}

// =======================================   Events propagation   ================================================
subscriber.on('message', (channel, message) => {
  if (channel === 'users') {
    const parsedUser = JSON.parse(message) 
    users.push(parsedUser)
    console.log("OK - User propagated")
  }

  if (channel === 'queue') {
    const parsedUser = JSON.parse(message)
    queue.push(parsedUser)
  }

  if (channel === 'create-room') {
    const roomId = message
    console.log("ROOM CREATED: ", roomId)
    rooms[roomId] = []
  }

  if (channel === 'add-to-room') {
    const splitedMessage = message.split("&&")
    const roomId = splitedMessage[0]
    const parsedUser = JSON.parse(splitedMessage[1])
    
    rooms[roomId].push(parsedUser)
  }

  if (channel === 'socketIds') {
    const splitedMessage = message.split("&&")
    const userId = splitedMessage[0]
    const socketId = splitedMessage[1]

    socketIds[userId] = socketId
  }

  if (channel === 'accept-match') {
    const splitedMessage = message.split("&&")
    const roomId = splitedMessage[0]
    const userIndex = splitedMessage[1]

    rooms[roomId][userIndex].hasAccepted = true
    console.log("One user has accepted")

    checkInAllHasAccepted(rooms[roomId], roomId)
  }
})





// ==========================================       Sockets        =============================================
io.on('connection', (socket) =>  {
  console.log("New user connected!")

  socket.on('hello', () => {
    io.emit('hi', "all sockets")
  })

  socket.on('check-in', (user) => {
    const message = `${user}&&${socket.id}`
    publisher.publish('socketIds', message)
  })

  socket.on('join', async () => {
    try {
      await io.of('/').adapter.remoteJoin(socket.id, 'room0');
    } catch (err) {
      console.log("error joining: ", err)
    }
  })

  socket.on('check-rooms', async () => {
    // const sockets = await io.in('room0').allSockets();
    //console.log(users); // a Set containing the socket ids in 'room3'
    
    dbClient.get('users', (err, data) => {
      console.log("Not parsed data: ", data)
      console.log("Parsed data: ", JSON.parse(data))
    })
    // console.log(u)
  })

  socket.on('check-queue', () => {
    console.log(queue)
  })

  socket.on('check-check-in', () => {
    console.log(socketIds)
  })

  socket.on('new-user', (newUser) => {
    console.log("New User Request ", newUser)
    const updatedUsers = users
    updatedUsers.push(newUser)
    setItem('users', JSON.stringify(updatedUsers))
    // publisher.publish('users', JSON.stringify(newUser))
  })

  socket.on('in-queue', (userId) => {
    console.log("Queue Request")
    publisher.publish('queue', userId)
  })

  socket.on('accept-match', async (userId) => {
    const roomId = findRoomId(userId) 
    const userIndex = findUserIndexInRoom(userId, roomId)

    // socket.join(roomId)
    try {
      await io.of('/').adapter.remoteJoin(socketIds[userId], roomId);
      console.log("Joined to the room!")
    } catch (err) {
      console.log("Could not join the room ", err)
    }
  
    const message = `${roomId}&&${userIndex}`
    publisher.publish("accept-match", message)
  })
})






// ====================================  Queue Interval Check  ===================================================
setInterval(() => {
  checkIfMatchAvailable()
}, updateInterval)

const checkIfMatchAvailable = () => {
  const matchedUsers = queue.filter(singleUser => (
    (singleUser.rank >= 0 && singleUser.rank <= 100)
  ))

  if (matchedUsers.length === minRoomSize) {
    const newRoomID = Math.random().toString(16).substr(2, 15)
    publisher.publish('create-room', newRoomID)
    
    matchedUsers.forEach((singleUser) => {
      io.sockets.to(socketIds[singleUser.id]).emit('matched')

      const newUserToRoom = {
        ...singleUser, hasAccepted: false
      }
      const message = `${newRoomID}&&${JSON.stringify(newUserToRoom)}`
      publisher.publish('add-to-room', message)
      
      queue = queue.filter(queueUser => queueUser.id !== singleUser.id)
    })
  }
}




// ========================================== REDIS METHODS ======================================================
const setItem = (key, value) => {
  dbClient.set(key, value)
}



// ==========================================   REST   ============================================================
app.get('/hello', (_, res) => {
  res.send('Hello there')
})

app.post('/get-in-queue', (req, res) => {
  const arrivedUser = req.body.user
  if (arrivedUser) {
    const userInQueue = users.filter(singleUser => singleUser.id === arrivedUser)[0]
    publisher.publish('queue', JSON.stringify(userInQueue))
    res.send(`User ${arrivedUser} added to queue`)
  } else {
    return res.status(400).json({description: 'Bad request. need ?user param', name: 'BadRequest'})
  }
})



server.listen(port, () => {
  console.log("Listening in port " + port)
})


// UTILS
const findRoomId = (userId) => {
  const roomsValues = Object.values(rooms)
  console.log("ROOM VALUES: ", roomsValues)
  const singleLevelValues = roomsValues.map(singleRoomValue => (
    singleRoomValue.map(singleObjectInsideRoom => singleObjectInsideRoom.id)
  ))
  const roomIndex = singleLevelValues.findIndex(roomMembers => roomMembers.includes(userId))
  const roomId = Object.keys(rooms)[roomIndex]
  return roomId
}

const findUserIndexInRoom = (userId, roomId) => {
  const userIndex = rooms[roomId].findIndex(userInRoom => (
    userInRoom.id === userId
  ))

  return userIndex
}

const checkInAllHasAccepted = (currentRoom, roomId) => {
  if (!currentRoom.map(userInRoom => userInRoom.hasAccepted).includes(false)) {
    console.log("EMITING REDIRECT")
    io.to(roomId).emit('match-accepted', currentRoom)
  }
}
