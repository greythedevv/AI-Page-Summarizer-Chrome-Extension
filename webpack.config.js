const path = require("path");
const Dotenv = require("dotenv-webpack");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    background: "./src/background.js",
    content: "./src/content.js",
    popup: "./src/popup.js",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "src/[name].js",
    clean: true,
  },
  plugins: [
    // Replaces process.env.* with literal values at build time
    // Values come from .env file — which is gitignored
    new Dotenv({
      safe: true, // enforces .env.example as the contract
    }),
    // Copy all static assets into dist/
    new CopyPlugin({
      patterns: [
        { from: "public/manifest.json", to: "manifest.json" },
        { from: "public/popup.html",    to: "popup.html"    },
        { from: "public/popup.css",     to: "popup.css"     },
        { from: "public/icons",         to: "icons"         },
      ],
    }),
  ],
  // Chrome extensions cannot use chunked output
  optimization: {
    runtimeChunk: false,
    splitChunks: false,
  },
};
