const path = require('path');
const {DefinePlugin, NormalModuleReplacementPlugin} = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: process.env.NODE_ENV === 'production' ? false : 'cheap-source-map',
    target: 'web',
    resolve: {
        // GUI-pinned lucide (webpack 4 cannot parse lucide 1.x ESM) + CJS rotur-sdk
        alias: {
            'lucide-react': path.resolve(__dirname, 'node_modules/scratch-gui/node_modules/lucide-react'),
            'rotur-sdk': path.resolve(__dirname, 'node_modules/scratch-gui/node_modules/rotur-sdk/dist/index.js')
        },
        mainFields: ['browser', 'main', 'module']
    },
    module: {
        rules: [
            {
                test: /\.m?jsx?$/,
                loader: 'babel-loader',
                options: {
                    presets: ['@babel/preset-env', '@babel/preset-react']
                }
            },
            {
                // The novatheai addon (and potentially others) ship .ts/.tsx
                // sources that are imported from plain JS. Transpile them the
                // same way scratch-gui does: ts-loader strips types first
                // (transpileOnly = no type-checking, fast), then babel-loader
                // handles JSX + downleveling.
                test: /\.tsx?$/,
                use: [
                    {
                        loader: 'babel-loader',
                        options: {
                            presets: ['@babel/preset-env', '@babel/preset-react']
                        }
                    },
                    {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true
                        }
                    }
                ]
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
            // scratch-gui/src/lib/git/sync-remotes.js imports ../rotur/git-api.js
            // which does not exist in the Bilup/scratch-gui#develop-builds package.
            // Use NormalModuleReplacementPlugin to intercept the relative import
            // at the beforeResolve stage (before resolution fails).
            new NormalModuleReplacementPlugin(
                /\.\.\/rotur\/git-api\.js$/,
                path.resolve(__dirname, 'src-renderer-webpack/editor/gui/rotur-git-api.js')
            ),
            // scratch-gui/src/lib/components/project-fetcher-hoc.jsx and
            // sb-file-uploader-hoc.jsx import ../git/project-history.js which
            // may not be present in the installed version of scratch-gui.
            // Provide a stub to avoid ReferenceError at runtime.
            new NormalModuleReplacementPlugin(
                /\.\.\/git\/project-history\.js$/,
                path.resolve(__dirname, 'src-renderer-webpack/editor/gui/project-history.js')
            ),
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
                // The browser bundle of just-bash still imports "node:zlib"
                // for its gzip/gunzip commands. Provide a stub that reports
                // compression as unavailable in the browser terminal.
                'node:zlib$': path.resolve(__dirname, 'src-renderer-webpack/editor/gui/just-bash-zlib.js'),
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
    },

    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/settings'),
            filename: 'index.js'
        },
        entry: './src-renderer-webpack/editor/settings/index.jsx',
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
                        context: 'src-renderer-webpack/editor/settings/',
                        from: '*.html'
                    }
                ]
            })
        ]
    }
];
