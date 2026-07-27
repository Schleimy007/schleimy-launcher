const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')
const b4a = require('b4a')
const net = require('net')

async function test() {
  const swarm1 = new Hyperswarm()
  const swarm2 = new Hyperswarm()

  // Generate a random topic
  const topic = crypto.createHash('sha256').update('test-topic-123').digest()

  // Swarm 1: acts as the Minecraft Server (Host)
  // Let's create a dummy local TCP server on port 50000 to simulate Minecraft LAN
  const mockServer = net.createServer(socket => {
    socket.write('Hello from Mock Minecraft Server!\n')
    socket.on('data', data => {
      console.log('Mock Server received:', data.toString())
      socket.write('Echo: ' + data.toString())
    })
  })
  mockServer.listen(50000, () => console.log('Mock Server listening on 50000'))

  swarm1.on('connection', (conn, info) => {
    console.log('Swarm1 got a connection!')
    // Pipe the swarm connection to the local mock server
    const localSocket = net.connect(50000, '127.0.0.1')
    conn.pipe(localSocket).pipe(conn)
  })
  swarm1.join(topic, { server: true, client: false })

  // Swarm 2: acts as the joining player
  // Let's create a local proxy server on port 25565 that the player connects to
  const localProxy = net.createServer(socket => {
    console.log('Player connected to local proxy! Proxying to Swarm2...')
    // We only need ONE connection to the host for this socket
    // But swarm2 might have multiple connections if there are multiple peers.
    // For a specific join code, there should be 1 host.
    const hostConn = Array.from(swarm2.connections)[0]
    if (hostConn) {
      socket.pipe(hostConn).pipe(socket)
    } else {
      socket.end('No host found')
    }
  })
  localProxy.listen(25565, () => console.log('Local Proxy listening on 25565'))

  swarm2.join(topic, { server: false, client: true })
  
  swarm2.on('connection', (conn, info) => {
    console.log('Swarm2 connected to Host!')
    // Now simulate a player connecting to the proxy
    const playerSocket = net.connect(25565, '127.0.0.1')
    playerSocket.on('data', data => console.log('Player received:', data.toString()))
    playerSocket.write('Ping!\n')
  })

  // Wait a bit and then clean up
  setTimeout(() => {
    mockServer.close()
    localProxy.close()
    swarm1.destroy()
    swarm2.destroy()
    process.exit(0)
  }, 3000)
}

test()
