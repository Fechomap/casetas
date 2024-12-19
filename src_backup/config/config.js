require('dotenv').config();

const config = {
  mongodb: {
    uri: `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0.jbyof.mongodb.net/tollboothdb?retryWrites=true&w=majority`,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN
  }
};

module.exports = config;