const path = require('path');
const {DefinePlugin} = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: process.env.NODE_ENV === 'production' ? false : 'cheap-source-map',
    target: 'web',
    // Bundle size warnings are meaningless for a desktop app that loads its
    // resources from local disk, and in this toolchain they fail the build.
    performance: {
        hints: false
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: [
                    {
                        loader: 'babel-loader',
                        options: {
                            babelrc: false,
                            presets: ['@babel/preset-env', '@babel/preset-react']
                        }
                    },
                    {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true,
                            configFile: 'tsconfig.json'
                        }
                    }
                ],
                include: (filePath) => {
                    const normalizedPath = filePath.toLowerCase();
                    if (normalizedPath.includes('node_modules')) {
                        if (normalizedPath.includes('scratch-gui') ||
                            normalizedPath.includes('pify') ||
                            normalizedPath.includes('@vernier') ||
                            normalizedPath.includes('@chenglou') ||
                            normalizedPath.includes('isomorphic-git')) {
                            return true;
                        }
                        return false;
                    }
                    return true;
                }
            },
            {
                test: /\.m?jsx?$/,
                loader: 'babel-loader',
                options: {
                    presets: ['@babel/preset-env', '@babel/preset-react']
                }
            },
            {
                test: /\.(svg|png|wav|gif|jpg|mp3|ttf|woff|woff2|eot|hex)$/,
                loader: 'file-loader',
                options: {
                    outputPath: 'static/assets/',
                    esModule: false
                }
            },
            {
                // These packages ship CSS that relies on global class names
                // (e.g. monaco's .codicon, xterm's .xterm, fontsource's
                // @font-face), so they must NOT be processed with CSS modules.
                test: /node_modules[\\/](?:@fontsource|@xterm[\\/]xterm|monaco-editor)[\\/].*\.css$/,
                use: ['style-loader', 'css-loader']
            },
            {
                test: /\.css$/,
                exclude: /node_modules[\\/](?:@fontsource|@xterm[\\/]xterm|monaco-editor)[\\/]/,
                use: [
                    {
                        loader: 'style-loader'
                    },
                    {
                        loader: 'css-loader',
                        options: {
                            modules: true,
                            importLoaders: 1,
                            localIdentName: '[name]_[local]_[hash:base64:5]',
                            camelCase: true
                        }
                    },
                    {
                        loader: 'postcss-loader',
                        options: {
                            postcssOptions: {
                                plugins: [
                                    'postcss-import',
                                    'postcss-simple-vars',
                                    'autoprefixer'
                                ]
                            }
                        }
                    }
                ]
            },
            {
                test: /\.less$/,
                use: [
                    {
                        loader: 'style-loader'
                    },
                    {
                        loader: 'css-loader',
                        options: {
                            modules: true,
                            importLoaders: 2,
                            localIdentName: '[name]_[local]_[hash:base64:5]',
                            camelCase: true
                        }
                    },
                    {
                        loader: 'postcss-loader',
                        options: {
                            postcssOptions: {
                                plugins: [
                                    'postcss-import',
                                    'postcss-simple-vars',
                                    'autoprefixer'
                                ]
                            }
                        }
                    },
                    {
                        loader: 'less-loader'
                    }
                ]
            }
        ]
    }
}

module.exports = [
    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/gui'),
            filename: 'index.js'
        },
        entry: './src-renderer-webpack/editor/gui/index.jsx',
        plugins: [
            new DefinePlugin({
                'process.env.ROOT': '""'
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: 'node_modules/scratch-blocks/media',
                        to: 'static/blocks-media/default'
                    },
                    {
                        from: 'node_modules/scratch-blocks/media',
                        to: 'static/blocks-media/high-contrast'
                    },
                    {
                        from: 'node_modules/scratch-gui/src/lib/themes/blocks/high-contrast-media/blocks-media',
                        to: 'static/blocks-media/high-contrast',
                        force: true
                    },
                    {
                        context: 'src-renderer-webpack/editor/gui/',
                        from: '*.html'
                    }
                ]
            })
        ],
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
            symlinks: false,
            alias: {
                react: path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
                'scratch-gui$': path.resolve(__dirname, 'node_modules/scratch-gui/src/index.js'),
                'scratch-render-fonts$': path.resolve(__dirname, 'node_modules/scratch-gui/src/lib/tw-scratch-render-fonts'),
                // webpack 4 ignores the "exports" field and resolves just-bash
                // via its "main" field, which points at the Node bundle
                // (uses import.meta/createRequire and can't be parsed).
                // Force the browser bundle instead.
                'just-bash$': path.resolve(__dirname, 'node_modules/just-bash/dist/bundle/browser.js'),
            }
        }
    },

    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/addons'),
            filename: 'index.js'
        },
        entry: './src-renderer-webpack/editor/addons/index.jsx',
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
            symlinks: false,
            alias: {
                react: path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom')
            }
        },
        plugins: [
            new CopyWebpackPlugin({
                patterns: [
                    {
                        context: 'src-renderer-webpack/editor/addons/',
                        from: '*.html'
                    }
                ]
            })
        ]
    }
];
