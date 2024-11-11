import { map } from 'nanostores';

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
  messages: [
    {
      role: 'assistant',
      content: 'To get started, run:\n```bash\nnpm install\nnpm run dev\n```',
    },
  ],
});
