import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CatalystOps',
  description: 'PySpark optimizer for VS Code — documentation',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/icon.png' }],
  ],

  themeConfig: {
    logo: { src: 'https://catalystops.dev/icon.png', alt: 'CatalystOps' },
    logoLink: 'https://catalystops.dev/',

    nav: [
      { text: 'Home', link: 'https://catalystops.dev/' },
      { text: 'Blog', link: 'https://catalystops.dev/blog/' },
      {
        text: 'Install',
        link: 'https://marketplace.visualstudio.com/items?itemName=CatalystOps.catalystops',
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Installation & Setup', link: '/getting-started' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Local Analysis', link: '/local-analysis' },
          { text: 'Schema Validation', link: '/schema-validation' },
          { text: 'Dry Run', link: '/dry-run' },
          { text: 'Plan Analysis & DAG', link: '/plan-analysis' },
          { text: 'Job Run Analysis', link: '/job-run-analysis' },
          { text: 'Clusters & SSH', link: '/clusters-ssh' },
          { text: 'Billing Dashboard', link: '/billing' },
          { text: 'Static Cost Estimation', link: '/static-cost' },
          { text: 'Asset Bundle Support', link: '/bundle' },
          { text: 'MCP Server', link: '/mcp' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'All Rules', link: '/rules' },
          { text: 'Settings', link: '/settings' },
          { text: 'Commands', link: '/commands' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/lezwon/CatalystOps' },
    ],

    editLink: {
      pattern: 'https://github.com/lezwon/CatalystOps/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the Elastic License 2.0.',
      copyright: '© 2026 SpendOps',
    },

    search: {
      provider: 'local',
    },
  },

  appearance: 'force-dark',
})
