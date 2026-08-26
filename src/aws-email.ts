import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { EmailSender } from './notifications.js';

export class SesEmailSender implements EmailSender {
  private readonly client = new SESv2Client({});
  constructor(private readonly from: string, private readonly to: string) {}
  async send(subject: string, text: string, html: string) {
    await this.client.send(new SendEmailCommand({ FromEmailAddress: this.from, Destination: { ToAddresses: [this.to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } } }));
  }
}
