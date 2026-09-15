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
                // 注意：这里刻意没有 exclude: /node_modules/，也没有 include 白名单。
                //
                // webpack 4.47 的解析器是 acorn 6.4.2，不认识 ES2020 语法（?. / ?? /
                // ||= / 类字段）。而 node_modules 里 just-bash、isomorphic-git、
                // @xterm、monaco-editor 等包大量使用这些语法，它们必须先经过 babel
                // 降级，webpack 才能解析。加 exclude 会让构建直接报
                // "Module parse failed"，这也是 .browserslistrc 里的目标不能抬高的
                // 同一个原因。
                //
                // 代价是 node_modules 里每个包都会被 babel 处理一遍，构建偏慢；要省掉
                // 这份开销需要先升级到 webpack 5，或者改成维护一份 include 白名单
                // （scratch-gui 网页端就是白名单方案，但漏掉任何一个含新语法的包都会
                // 让构建挂掉，收益主要是构建时间而不是运行性能）。
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
                // 与网页端 scratch-gui/webpack.config.js 保持一致：小于 2KB 的
                // 资源内联成 data URL。
                //
                // 改造前用的是 file-loader，等于每个小图标/音效/字体都要走一次
                // tw-editor:// 协议请求——每次都要主进程读盘再回一次 IPC。打开
                // 素材库、积木面板（blocks-media 里有大量小图标）时这类请求会
                // 集中爆发，也是"桌面端比网页端慢"的一部分。网页端用
                // url-loader limit 2048 把它们直接内联掉，这里对齐。
                // 超过 limit 的文件仍由 file-loader 落盘（url-loader 会自动回退）。
                test: /\.(svg|png|wav|gif|jpg|mp3|ttf|woff|woff2|eot|hex)$/,
                loader: 'url-loader',
                options: {
                    limit: 2048,
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
    },
    optimization: {
        // 异步块的拆分策略。
        //
        // 改造前这里没有任何 splitChunks 配置，走的是 webpack 4 生产默认值
        // （chunks: 'async'）。默认值本身能用，问题在别处：just-bash（浏览器包
        // 1.2MB）、isomorphic-git、lightning-fs、JSZip 原本是被
        // rotur-session.jsx 静态引进来的，因而算进了初始包——每个用户启动时都
        // 要下载并解析这几 MB，哪怕从不打开 Fractch 终端或 Git 面板。
        // 那处静态引用已经切断（见 scratch-gui 的 src/lib/git/shell-user.js），
        // 它们现在只会落在异步块里。这里显式命名，作用有两个：
        //   1. Git 面板与终端共用同一份异步块，而不是各自打包一份；
        //   2. 名字固定 + contenthash，排查和命中 code cache 都更可控。
        //
        // chunks 刻意保持 'async'：初始包不拆分，这样 HTML 里仍然只需要一个
        // <script src="index.js">，不必为注入额外的初始块去改
        // gui.html / addons.html / settings.html（改错了就是编辑器白屏）。
        splitChunks: {
            chunks: 'async',
            minSize: 30000,
            cacheGroups: {
                // 只在终端/Git 面板用到的 shell + git 栈
                gitLibs: {
                    test: /node_modules[\\/](?:isomorphic-git|@isomorphic-git|lightning-fs|jszip|just-bash)[\\/]/,
                    name: 'git-libs',
                    priority: 20,
                    reuseExistingChunk: true
                },
                // 代码编辑器，只有 Fractch 工作区（React.lazy）会用到
                monacoEditor: {
                    test: /node_modules[\\/]monaco-editor[\\/]/,
                    name: 'monaco-editor',
                    priority: 20,
                    reuseExistingChunk: true
                },
                xterm: {
                    test: /node_modules[\\/](?:@xterm|xterm)[\\/]/,
                    name: 'xterm',
                    priority: 20,
                    reuseExistingChunk: true
                }
            }
        }
    }
}

module.exports = [
    {
        ...base,
        output: {
            path: path.resolve(__dirname, 'dist-renderer-webpack/editor/gui'),
            filename: 'index.js',
            // 异步块（monaco / xterm / git-libs / 各 React.lazy 面板）按内容命名。
            // 改造前没有 chunkFilename，用的是默认 [id].js：模块顺序一变，同一个
            // URL 就可能装不同内容——这会污染 Chromium 里按 URL 索引的 V8 code
            // cache（见 src-main/protocols.js 的 codeCache 权限）。加上 contenthash
            // 后 URL 随内容变化，和网页端产物的做法一致。
            chunkFilename: '[name].[contenthash:8].js',
            // 必须保持相对路径：块从入口脚本所在目录加载，由 tw-editor:// 协议提供。
            publicPath: ''
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
            // 兜底依赖查找:scratch-gui 作为 git 依赖安装时,若其嵌套依赖未被
            // hoist 到顶层(npm 经典布局),desktop 自己的入口文件(addons/
            // settings 的 index.jsx 等)import react-intl / @bilup/scratch-l10n
            // 等裸模块会解析失败,导致该入口编译失败、产物缺失(表现为
            // tw-editor:// 页面 404)。把 scratch-gui 的 node_modules 加入候选,
            // hoist 布局下该目录不存在也不影响顶层查找。
            modules: [
                path.resolve(__dirname, 'node_modules/scratch-gui/node_modules'),
                'node_modules'
            ],
            alias: {
                react: path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
                // 设置窗口渲染 gui 社区 Settings 页,依赖 react-router 的
                // useSearchParams/useLocation。若 desktop(顶层)与 gui 各自
                // 解析到不同的 react-router 物理副本,context 不互通会表现成
                // "Router 外调用"并抛错,因此强制全部指向顶层单一实例。
                'react-router$': path.resolve(__dirname, 'node_modules/react-router'),
                'react-router-dom$': path.resolve(__dirname, 'node_modules/react-router-dom'),
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
            filename: 'index.js',
            chunkFilename: '[name].[contenthash:8].js',
            publicPath: ''
        },
        entry: './src-renderer-webpack/editor/addons/index.jsx',
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
            symlinks: false,
            modules: [
                path.resolve(__dirname, 'node_modules/scratch-gui/node_modules'),
                'node_modules'
            ],
            alias: {
                react: path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
                'react-router$': path.resolve(__dirname, 'node_modules/react-router'),
                'react-router-dom$': path.resolve(__dirname, 'node_modules/react-router-dom')
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
            filename: 'index.js',
            chunkFilename: '[name].[contenthash:8].js',
            publicPath: ''
        },
        entry: './src-renderer-webpack/editor/settings/index.jsx',
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
            symlinks: false,
            modules: [
                path.resolve(__dirname, 'node_modules/scratch-gui/node_modules'),
                'node_modules'
            ],
            alias: {
                react: path.resolve(__dirname, 'node_modules/react'),
                'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
                'react-router$': path.resolve(__dirname, 'node_modules/react-router'),
                'react-router-dom$': path.resolve(__dirname, 'node_modules/react-router-dom')
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
