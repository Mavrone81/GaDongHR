import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import type { EmailTransport } from './notify.service'

export interface SmtpOptions {
  host: string
  port: number
  secure: boolean
  from: string
  user?: string
  pass?: string
}

/**
 * The one production `EmailTransport` implementation — everywhere else
 * (every test in this service) injects a fake instead (Task 11 brief
 * constraints: "no real SMTP here"). Kept deliberately thin: `send`/
 * `verify` are the entire surface `NotifyService`/`NotifyController` need,
 * so swapping SMTP providers or adding a real employee-directory lookup
 * (see `notify.service.ts`'s `placeholderEmailAddress`) touches only this
 * file.
 */
export class NodemailerEmailTransport implements EmailTransport {
  private readonly transporter: Transporter
  private readonly from: string

  constructor(options: SmtpOptions) {
    this.from = options.from
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user && options.pass ? { user: options.user, pass: options.pass } : undefined,
    })
  }

  async send(message: { to: string; subject: string; body: string }): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.body })
  }

  async verify(): Promise<boolean> {
    try {
      return await this.transporter.verify()
    } catch {
      return false
    }
  }
}
