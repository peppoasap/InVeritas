import { Server } from './server';

const server = Server.getInstance();
server.listen().then(() => {
    console.log('Server is running');
});
