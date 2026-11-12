
export const dynamic = 'force-dynamic';

import {Login} from "@gitroom/frontend/components/auth/login";
import {Metadata} from "next";
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true' ? 'REKTRS Social' : isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Login`,
  description: process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true'
    ? 'REKTRS Social is a self-hosted social media management and publishing workspace.'
    : '',
};

export default async function Auth() {
    return (
        <Login />
    );
}
