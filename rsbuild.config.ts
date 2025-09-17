import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'

// @ts-expect-error This file is run in a Node.js environment
const mode = process.env.NODE_ENV || 'development'

export default defineConfig({
  html: {
    title: 'Editor prototype',
  },
  output: {
    assetPrefix: '/2025-09-17-editor-with-mixins/',
    sourceMap: {
      js: mode === 'development' ? 'eval-source-map' : 'source-map',
      css: true,
    },
  },
  plugins: [pluginReact()],
})
