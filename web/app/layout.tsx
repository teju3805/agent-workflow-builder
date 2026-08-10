import './globals.css';
import Providers from './providers';

export const metadata = {
  title: 'Workflow runner',
  description: 'Build and run AI agent workflows',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
