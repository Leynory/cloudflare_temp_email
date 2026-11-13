import { Context } from "hono";
import { Telegraf, Context as TgContext, Markup } from "telegraf";
import { callbackQuery } from "telegraf/filters";

import { CONSTANTS } from "../constants";
import { getBooleanValue, getDomains, getJsonObjectValue, trimLower, htmlToText } from '../utils';
import { TelegramSettings } from "./settings";
import { sendTelegramAttachments } from "./tg_file_upload";
import { bindTelegramAddress, deleteTelegramAddress, jwtListToAddressData, tgUserNewAddress, unbindTelegramAddress, unbindTelegramByAddress } from "./common";
import { commonParseMail } from "../common";
import { resolveRawEmail } from "../gzip";
import { UserFromGetMe } from "telegraf/types";
import i18n from "../i18n";
import { LocaleMessages } from "../i18n/type";
import type { ExtractResult, RawMailRow } from "../models";

// === ЕДИНСТВЕННАЯ КАРТИНКА ДЛЯ КОМАНДЫ /start ===
const TG_START_IMAGE = "https://gachadevsuki.com/tgassets1.png";

// Bilingual command descriptions (RU/EN)
const COMMANDS = [
    {
        command: "start",
        description: "Начать | Get started"
    },
    {
        command: "new",
        description: "Новый ящик, /new <name>@<domain> | Create address, /new <name>@<domain>"
    },
    {
        command: "address",
        description: "Список ящиков | View address list"
    },
    {
        command: "bind",
        description: "Привязать ящик, /bind <credential> | Bind address, /bind <credential>"
    },
    {
        command: "unbind",
        description: "Отвязать ящик, /unbind <address> | Unbind address, /unbind <address>"
    },
    {
        command: "delete",
        description: "Удалить ящик, /delete <address> | Delete address, /delete <address>"
    },
    {
        command: "mails",
        description: "Почта, /mails <address> | View mails, /mails <address>"
    },
    {
        command: "cleaninvalidaddress",
        description: "Очистить недействительные | Clean invalid addresses"
    },
    {
        command: "lang",
        description: "Язык /lang <ru|en> | Set language /lang <ru|en>"
    },
]

// Helper to get messages by userId
const getTgMessages = async (
    c: Context<HonoCustomType>,
    ctx?: TgContext,
    userId?: string | null
): Promise<LocaleMessages> => {
    // Если переключение языка выключено, всегда используем русский
    if (!getBooleanValue(c.env.TG_ALLOW_USER_LANG)) {
        return i18n.getMessages(c.env.DEFAULT_LANG === 'en' ? 'en' : 'ru');
    }

    const uid = userId || ctx?.message?.from?.id?.toString() || ctx?.callbackQuery?.from?.id?.toString();
    if (uid) {
        const savedLang = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${uid}`);
        // Разрешаем только ru и en
        if (savedLang === 'ru' || savedLang === 'en') { 
            return i18n.getMessages(savedLang); 
        }
    }
    
    // По умолчанию ставим русский (или английский, если так указано в конфиге)
    return i18n.getMessages(c.env.DEFAULT_LANG === 'en' ? 'en' : 'ru');
};

const formatAiExtractForTelegram = (
    msgs: LocaleMessages,
    aiExtract?: ExtractResult | string | null
): string => {
    if (!aiExtract) {
        return "";
    }

    try {
        if (typeof aiExtract === "string") {
            const metadata = JSON.parse(aiExtract);
            aiExtract = metadata?.ai_extract;
        }
    } catch (error) {
        console.warn("Failed to parse AI extraction metadata", error);
        return "";
    }

    if (!aiExtract || typeof aiExtract !== "object") {
        return "";
    }

    const labels: Record<Exclude<ExtractResult["type"], "none">, string> = {
        auth_code: msgs.TgAiExtractAuthCodeMsg,
        auth_link: msgs.TgAiExtractAuthLinkMsg,
        service_link: msgs.TgAiExtractServiceLinkMsg,
        subscription_link: msgs.TgAiExtractSubscriptionLinkMsg,
        other_link: msgs.TgAiExtractOtherLinkMsg,
    };
    const label = labels[aiExtract.type as keyof typeof labels];
    const result = typeof aiExtract.result === "string"
        ? aiExtract.result.replace(/\s+/g, " ").trim().slice(0, 600)
        : "";
    if (!result) {
        return "";
    }

    if (!label) {
        return "";
    }

    const resultText = typeof aiExtract.result_text === "string"
        ? aiExtract.result_text.replace(/\s+/g, " ").trim().slice(0, 120)
        : "";
    const displayText = aiExtract.type !== "auth_code" && resultText && resultText !== result
        ? ` (${resultText})`
        : "";
    return `${msgs.TgAiExtractResultMsg}\n${label}: ${result}${displayText}\n\n`;
}

export const getTelegramCommands = (c: Context<HonoCustomType>) => {
    return getBooleanValue(c.env.TG_ALLOW_USER_LANG)
        ? COMMANDS
        : COMMANDS.filter(cmd => cmd.command !== "lang");
}

export function newTelegramBot(c: Context<HonoCustomType>, token: string): Telegraf {
    const bot = new Telegraf(token);
    const botInfo = getJsonObjectValue<UserFromGetMe>(c.env.TG_BOT_INFO);
    if (botInfo) {
        bot.botInfo = botInfo;
    }

    bot.use(async (ctx, next) => {
        // check if in private chat
        if (ctx.chat?.type !== "private") {
            return;
        }

        const userId = ctx?.message?.from?.id || ctx?.callbackQuery?.message?.chat?.id;
        if (!userId) {
            const msgs = await getTgMessages(c, ctx);
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }

        const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
        if (settings?.enableAllowList
            && !settings.allowList.includes(userId.toString())
        ) {
            const msgs = await getTgMessages(c, ctx);
            return await ctx.reply(msgs.TgNoPermissionMsg);
        }
        try {
            await next();
        } catch (error) {
            console.error(`Error: ${error}`);
            return await ctx.reply(`Error: ${error}`);
        }
    })

    bot.command("start", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const prefix = trimLower(c.env.PREFIX)
        const domains = getDomains(c);
        const commands = getTelegramCommands(c);
        
        const text = `${msgs.TgWelcomeMsg}\n\n`
            + (prefix ? `${msgs.TgCurrentPrefixMsg} ${prefix}\n` : '')
            + `${msgs.TgCurrentDomainsMsg} ${JSON.stringify(domains)}\n`
            + `${msgs.TgAvailableCommandsMsg}\n`
            + commands.map(cmd => `/${cmd.command}: ${cmd.description}`).join("\n");

        // ЕДИНСТВЕННАЯ КАРТИНКА ЗДЕСЬ
        return await ctx.replyWithPhoto(TG_START_IMAGE, {
            caption: text
        });
    });

    bot.command("new", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/new".length).trim();
            const res = await tgUserNewAddress(c, userId.toString(), address, msgs);
            const text = `${msgs.TgCreateSuccessMsg}\n`
                + `${msgs.TgAddressMsg} ${res.address}\n`
                + (res.password ? `${msgs.TgPasswordMsg} \`${res.password}\`\n` : '')
                + `${msgs.TgCredentialMsg} \`${res.jwt}\`\n`;

            return await ctx.reply(text, { parse_mode: "Markdown" });
        } catch (e) {
            return await ctx.reply(`${msgs.TgCreateFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("bind", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const jwt = ctx?.message?.text.slice("/bind".length).trim();
            if (!jwt) {
                return await ctx.reply(msgs.TgPleaseInputCredentialMsg);
            }
            const address = await bindTelegramAddress(c, userId.toString(), jwt, msgs);
            const text = `${msgs.TgBindSuccessMsg}\n`
                + `${msgs.TgAddressMsg} ${address}`;
                
            return await ctx.reply(text);
        }
        catch (e) {
            return await ctx.reply(`${msgs.TgBindFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("unbind", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/unbind".length).trim();
            if (!address) {
                return await ctx.reply(msgs.TgPleaseInputAddressMsg);
            }
            await unbindTelegramAddress(c, userId.toString(), address);
            const text = `${msgs.TgUnbindSuccessMsg}\n${msgs.TgAddressMsg} ${address}`;
            
            return await ctx.reply(text);
        }
        catch (e) {
            return await ctx.reply(`${msgs.TgUnbindFailedMsg} ${(e as Error).message}`);
        }
    })

    bot.command("delete", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            // @ts-ignore
            const address = ctx?.message?.text.slice("/delete".length).trim();
            if (!address) {
                return await ctx.reply(msgs.TgPleaseInputAddressMsg);
            }
            await deleteTelegramAddress(c, userId.toString(), address, msgs);
            
            return await ctx.reply(`${msgs.TgDeleteSuccessMsg} ${address}`);
        } catch (e) {
            return await ctx.reply(`${msgs.TgDeleteFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("address", async (ctx) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
            const { addressList } = await jwtListToAddressData(c, jwtList, msgs);
            const text = `${msgs.TgAddressListMsg}\n\n`
                + addressList.map(a => `${msgs.TgAddressMsg} ${a}`).join("\n");
                
            return await ctx.reply(text);
        } catch (e) {
            return await ctx.reply(`${msgs.TgGetAddressFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("cleaninvalidaddress", async (ctx: TgContext) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        try {
            const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
            const { invalidJwtList } = await jwtListToAddressData(c, jwtList, msgs);
            const newJwtList = jwtList.filter(jwt => !invalidJwtList.includes(jwt));
            await c.env.KV.put(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, JSON.stringify(newJwtList));
            const { addressList } = await jwtListToAddressData(c, newJwtList, msgs);
            
            const text = `${msgs.TgCleanSuccessMsg}\n\n`
                + `${msgs.TgCurrentAddressListMsg}\n\n`
                + addressList.map(a => `${msgs.TgAddressMsg} ${a}`).join("\n");

            return await ctx.reply(text);
        } catch (e) {
            return await ctx.reply(`${msgs.TgCleanFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.command("lang", async (ctx: TgContext) => {
        const userId = ctx?.message?.from?.id;
        if (!userId) {
            const msgs = await getTgMessages(c, ctx);
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }

        const msgs = await getTgMessages(c, ctx);

        if (!getBooleanValue(c.env.TG_ALLOW_USER_LANG)) {
            return await ctx.reply(msgs.TgLangFeatureDisabledMsg);
        }

        // @ts-ignore
        const lang = ctx?.message?.text.slice("/lang".length).trim().toLowerCase();
        if (lang === 'ru' || lang === 'en') {
            await c.env.KV.put(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`, lang);
            return await ctx.reply(`${msgs.TgLangSetSuccessMsg} ${lang === 'ru' ? 'Русский' : 'English'}`);
        }

        const currentLang = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`);
        const text = `${msgs.TgCurrentLangMsg} ${currentLang || 'auto'}\n`
            + `${msgs.TgSelectLangMsg}\n`
            + `/lang ru - Русский\n`
            + `/lang en - English`;

        return await ctx.reply(text);
    });

    const queryMail = async (ctx: TgContext, queryAddress: string, mailIndex: number, edit: boolean) => {
        const msgs = await getTgMessages(c, ctx);
        const userId = ctx?.message?.from?.id || ctx.callbackQuery?.message?.chat?.id;
        if (!userId) {
            return await ctx.reply(msgs.TgUnableGetUserInfoMsg);
        }
        const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
        const { addressList, addressIdMap } = await jwtListToAddressData(c, jwtList, msgs);
        if (!queryAddress && addressList.length > 0) {
            queryAddress = addressList[0];
        }
        if (!(queryAddress in addressIdMap)) {
            return await ctx.reply(`${msgs.TgNotBoundAddressMsg} ${queryAddress}`);
        }
        const address_id = addressIdMap[queryAddress];
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ? `
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return await ctx.reply(msgs.TgInvalidAddressMsg);
        }
        const mailRow = await c.env.DB.prepare(
            `SELECT * FROM raw_mails where address = ? `
            + ` order by id desc limit 1 offset ?`
        ).bind(
            queryAddress, mailIndex
        ).first<RawMailRow>();
        const raw = mailRow ? await resolveRawEmail(mailRow) : undefined;
        const mailId = mailRow?.id;
        const created_at = mailRow?.created_at;
        const { mail } = raw
            ? await parseMail(msgs, { rawEmail: raw }, queryAddress, created_at, mailRow?.metadata)
            : { mail: msgs.TgNoMoreMailsMsg };
        const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
        const miniAppButtons = []
        if (settings?.miniAppUrl && settings?.miniAppUrl?.length > 0 && mailId) {
            const url = new URL(settings.miniAppUrl);
            url.pathname = "/telegram_mail"
            url.searchParams.set("mail_id", mailId);
            miniAppButtons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
        }
        
        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback(msgs.TgPrevBtnMsg, `mail_${queryAddress}_${mailIndex - 1}`, mailIndex <= 0),
            ...miniAppButtons,
            Markup.button.callback(msgs.TgNextBtnMsg, `mail_${queryAddress}_${mailIndex + 1}`, !raw),
        ]);

        if (edit) {
            return await ctx.editMessageText(mail || msgs.TgNoMailMsg, { reply_markup: keyboard.reply_markup });
        }
        
        return await ctx.reply(mail || msgs.TgNoMailMsg, { reply_markup: keyboard.reply_markup });
    }

    bot.command("mails", async ctx => {
        const msgs = await getTgMessages(c, ctx);
        try {
            const queryAddress = ctx?.message?.text.slice("/mails".length).trim();
            return await queryMail(ctx, queryAddress, 0, false);
        } catch (e) {
            return await ctx.reply(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`);
        }
    });

    bot.on(callbackQuery("data"), async ctx => {
        const msgs = await getTgMessages(c, ctx);
        // Use ctx.callbackQuery.data
        try {
            const data = ctx.callbackQuery.data;
            if (data && data.startsWith("mail_") && data.split("_").length === 3) {
                const [_, queryAddress, mailIndex] = data.split("_");
                await queryMail(ctx, queryAddress, parseInt(mailIndex), true);
            }
        }
        catch (e) {
            console.log(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`, e);
            return await ctx.answerCbQuery(`${msgs.TgGetMailFailedMsg} ${(e as Error).message}`);
        }
        await ctx.answerCbQuery();
    });

    return bot;
}


export async function initTelegramBotCommands(c: Context<HonoCustomType>, bot: Telegraf) {
    await bot.telegram.setMyCommands(getTelegramCommands(c));
}

const parseMail = async (
    msgs: LocaleMessages,
    parsedEmailContext: ParsedEmailContext,
    address: string,
    created_at: string | undefined | null,
    aiExtract?: ExtractResult | string | null
) => {
    if (!parsedEmailContext.rawEmail) {
        return {};
    }
    try {
        const parsedEmail = await commonParseMail(parsedEmailContext);
        let parsedText = parsedEmail?.text || "";
        if (!parsedText.trim() && parsedEmail?.html) {
            parsedText = htmlToText(parsedEmail.html);
        }
        if (parsedText.length && parsedText.length > 1000) {
            parsedText = parsedText.substring(0, 1000) + `\n\n...\n${msgs.TgMsgTooLongMsg}`;
        }
        return {
            isHtml: false,
            mail: formatAiExtractForTelegram(msgs, aiExtract)
                + `From: ${parsedEmail?.sender || msgs.TgNoSenderMsg}\n`
                + `To: ${address}\n`
                + (created_at ? `Date: ${created_at}\n` : "")
                + `Subject: ${parsedEmail?.subject}\n`
                + `Content:\n${parsedText || msgs.TgParseFailedViewInAppMsg}`
        };
    } catch (e) {
        return {
            isHtml: false,
            mail: `${msgs.TgParseMailFailedMsg} ${(e as Error).message}`
        };
    }
}


export async function sendMailToTelegram(
    c: Context<HonoCustomType>, address: string,
    parsedEmailContext: ParsedEmailContext,
    mailId: number | undefined,
    aiExtract?: ExtractResult | null
) {
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.KV) {
        return;
    }
    const userId = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:${address}`);
    const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
    const globalPush = settings?.enableGlobalMailPush && settings?.globalMailPushList;
    if (!userId && !globalPush) {
        return;
    }
    const bot = newTelegramBot(c, c.env.TELEGRAM_BOT_TOKEN);

    const buildAndSend = async (targetUserId: string, msgs: LocaleMessages) => {
        const { mail } = await parseMail(
            msgs, parsedEmailContext, address, new Date().toUTCString(), aiExtract
        );
        if (!mail) return;
        const attachments = parsedEmailContext.parsedEmail?.attachments || [];
        const buttons = [];
        if (settings?.miniAppUrl && mailId) {
            const url = new URL(settings.miniAppUrl);
            url.pathname = "/telegram_mail"
            url.searchParams.set("mail_id", String(mailId));
            buttons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
        }
        await bot.telegram.sendMessage(targetUserId, mail, {
            ...Markup.inlineKeyboard([...buttons])
        });
        // send attachments via native fetch (telegraf multipart upload is incompatible with CF Workers)
        if (getBooleanValue(c.env.ENABLE_TG_PUSH_ATTACHMENT) && attachments.length > 0) {
            const caption = `From: ${parsedEmailContext.parsedEmail?.sender || ""}\nSubject: ${parsedEmailContext.parsedEmail?.subject || ""}`;
            await sendTelegramAttachments(c.env.TELEGRAM_BOT_TOKEN, targetUserId, attachments, caption);
        }
    };

    if (globalPush) {
        const globalMsgs = i18n.getMessages(c.env.DEFAULT_LANG === 'en' ? 'en' : 'ru');
        for (const pushId of settings.globalMailPushList) {
            await buildAndSend(pushId, globalMsgs);
        }
    }

    if (userId) {
        const userMsgs = await getTgMessages(c, undefined, userId);
        await buildAndSend(userId, userMsgs);
    }
}
