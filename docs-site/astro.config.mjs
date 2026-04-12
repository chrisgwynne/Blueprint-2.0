import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Blueprint',
      description: 'A personal business operating system powered by AI agents',
      social: {
        github: 'https://github.com/chrisgwynne/blueprint',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', link: '/getting-started/installation/' },
            { label: 'Docker Setup', link: '/getting-started/docker/' },
            { label: 'Configuration', link: '/getting-started/configuration/' },
            { label: 'First Steps', link: '/getting-started/first-steps/' },
          ],
        },
        {
          label: 'Connectors',
          collapsed: false,
          autogenerate: { directory: 'connectors' },
        },
        {
          label: 'Agents',
          autogenerate: { directory: 'agents' },
        },
        {
          label: 'Knowledge Base',
          autogenerate: { directory: 'knowledge-base' },
        },
        {
          label: 'Signals & Tasks',
          items: [
            { label: 'Signal Rules', link: '/signals/overview/' },
            { label: 'Approval Flows', link: '/tasks/approval-flows/' },
            { label: 'Write-Back Actions', link: '/tasks/write-back/' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { label: 'Agent Protocol (BAP)', link: '/integrations/bap-protocol/' },
            { label: 'REST API', link: '/integrations/api-reference/' },
            { label: 'Telegram', link: '/integrations/telegram/' },
            { label: 'Webhooks', link: '/integrations/webhooks/' },
          ],
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deployment' },
        },
      ],
    }),
  ],
});
