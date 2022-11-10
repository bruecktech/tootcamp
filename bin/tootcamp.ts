#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {MastodonStack} from '../lib/mastodon-stack';

const app = new cdk.App();
new MastodonStack(app, 'Tootcamp', {
    env: {account: '441900617518', region: 'eu-central-1'},
    domain: 'toot.camp',
    smtpFromAddress: 'notifications@toot.camp',
});