import { MediaLayoutComponent } from '@gitroom/frontend/components/new-layout/layout.media.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true' ? 'REKTRS Social' : isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Media`,
  description: '',
};

export default async function Page() {
  return <MediaLayoutComponent />
}
