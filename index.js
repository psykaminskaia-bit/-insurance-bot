const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

const token = process.env.BOT_TOKEN;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(token, { polling: true });

// ===== КАСТОМНЫЕ ПОЛЯ =====
const TG_CHAT_FIELD = 'UF_CRM_1778707506087';

const REMINDER_30 = 'UF_CRM_1778709367275';
const REMINDER_14 = 'UF_CRM_1778709381091';
const REMINDER_7 = 'UF_CRM_1778709393875';
const REMINDER_1 = 'UF_CRM_1778709409708';

// ===== ПАМЯТЬ =====
const userData = {};
let fieldsCache = null;

// ===== HELPERS =====
function formatDate(dateString) {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('ru-RU');
}

function formatMoney(value) {
    if (!value) return '-';
    return parseFloat(value).toLocaleString('ru-RU');
}

function getStatus(endDate) {
    if (!endDate) return '-';

    const now = new Date();
    const end = new Date(endDate);

    if (end < now) return '🔴 Истёк';

    const diffDays = Math.ceil((end - now) / (1000 * 60 * 60 * 24));

    if (diffDays <= 30) {
        return `🟡 Истекает через ${diffDays} дн.`;
    }

    return '🟢 Активен';
}

function getPolisWord(count) {
    if (count % 10 === 1 && count % 100 !== 11) return 'полис';
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'полиса';
    return 'полисов';
}

function daysUntil(dateString) {
    const now = new Date();
    const end = new Date(dateString);

    return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
}

async function getFields() {
    if (fieldsCache) return fieldsCache;

    const res = await axios.get(`${BITRIX_WEBHOOK}crm.deal.fields`);
    fieldsCache = res.data.result;

    return fieldsCache;
}

function getEnum(field, id) {
    if (!field?.items) return '-';

    const found = field.items.find(i => i.ID == id);
    return found ? found.VALUE : '-';
}

async function getAllDeals() {
    let allDeals = [];
    let start = 0;

    while (true) {
        const res = await axios.get(`${BITRIX_WEBHOOK}crm.deal.list`, {
            params: {
                filter: {},
                select: ['*', 'UF_*'],
                start
            }
        });

        const batch = res.data.result || [];
        allDeals = allDeals.concat(batch);

        if (batch.length < 50) break;

        start += 50;
    }

    return allDeals;
}

async function getContact(contactId) {
    const res = await axios.get(`${BITRIX_WEBHOOK}crm.contact.get`, {
        params: { id: contactId }
    });

    return res.data.result;
}
function isAutoPolicy(typeName) {
    return typeName === 'ОСАГО' || typeName === 'КАСКО';
}

function isRenewed(oldDeal, allDeals, fields) {
    const oldType = getEnum(fields.UF_CRM_1733304911569, oldDeal.UF_CRM_1733304911569);

    for (const deal of allDeals) {
        if (deal.ID === oldDeal.ID) continue;
        if (deal.CONTACT_ID !== oldDeal.CONTACT_ID) continue;

        const type = getEnum(fields.UF_CRM_1733304911569, deal.UF_CRM_1733304911569);

        if (type !== oldType) continue;

        const end = new Date(deal.UF_CRM_1733304976338);
        const now = new Date();

        if (end < now) continue;

        if (isAutoPolicy(type)) {
            if (
                deal.UF_CRM_1733305134235 &&
                oldDeal.UF_CRM_1733305134235 &&
                deal.UF_CRM_1733305134235 === oldDeal.UF_CRM_1733305134235
            ) {
                return true;
            }
        } else {
            return true;
        }
    }

    return false;
}

function getReminderField(days) {
    if (days === 30) return REMINDER_30;
    if (days === 14) return REMINDER_14;
    if (days === 7) return REMINDER_7;
    if (days === 1) return REMINDER_1;
    return null;
}

async function markReminderSent(dealId, fieldCode) {
    await axios.post(`${BITRIX_WEBHOOK}crm.deal.update`, null, {
        params: {
            id: dealId,
            fields: {
                [fieldCode]: 1
            }
        }
    });
}

async function sendRenewRequest(chatId, user, dealId) {
    const dealRes = await axios.get(`${BITRIX_WEBHOOK}crm.deal.get`, {
        params: { id: dealId }
    });

    const deal = dealRes.data.result;
    const fields = await getFields();

    const typeName = getEnum(fields.UF_CRM_1733304911569, deal.UF_CRM_1733304911569);
    const companyName = getEnum(fields.UF_CRM_1733304804509, deal.UF_CRM_1733304804509);

    const contact = await getContact(user.contactId);

    const clientName = `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim();

    const message = `🔥 ЗАЯВКА НА ПРОДЛЕНИЕ
👤 Клиент: ${clientName}
📞 Телефон: ${user.phone}
📄 Полис: ${deal.UF_CRM_1733304951785 || '-'}
📌 Вид: ${typeName}
🏢 Компания: ${companyName}
🆔 Сделка: ${dealId}`;

    await bot.sendMessage(ADMIN_CHAT_ID, message);

    await bot.sendMessage(
        chatId,
        '✅ Заявка отправлена! Мы скоро свяжемся с вами'
    );
}
async function runReminderJob() {
    console.log('REMINDER JOB STARTED');

    try {
        const allDeals = await getAllDeals();
        const fields = await getFields();

        const grouped = {};

        for (const deal of allDeals) {
            if (deal.STAGE_SEMANTIC_ID !== 'S') continue;
            if (!deal.CONTACT_ID) continue;
            if (!deal.UF_CRM_1733304976338) continue;

            const days = daysUntil(deal.UF_CRM_1733304976338);

            if (![30, 14, 7, 1].includes(days)) continue;

            const reminderField = getReminderField(days);

            if (!reminderField) continue;
            if (deal[reminderField]) continue;
            if (isRenewed(deal, allDeals, fields)) continue;

            const contact = await getContact(deal.CONTACT_ID);
            const chatId = contact[TG_CHAT_FIELD];

            if (!chatId) continue;

            if (!grouped[chatId]) {
                grouped[chatId] = [];
            }

            const typeName = getEnum(
                fields.UF_CRM_1733304911569,
                deal.UF_CRM_1733304911569
            );

            grouped[chatId].push({
                deal,
                days,
                typeName
            });

            await markReminderSent(deal.ID, reminderField);
        }

        for (const chatId of Object.keys(grouped)) {
            const items = grouped[chatId];

            let text = `🔔 Напоминание о продлении

У вас скоро заканчиваются полисы:

`;

            const keyboard = [];

            for (const item of items) {
                text += `• ${item.typeName} — через ${item.days} дн.\n`;

                keyboard.push([
                    {
                        text: `🔄 Продлить ${item.typeName}`,
                        callback_data: `renew_${item.deal.ID}`
                    }
                ]);
            }

            await bot.sendMessage(chatId, text, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        }

    } catch (e) {
        console.log('REMINDER ERROR:', e.message);
    }
}

// ===== CRON =====
cron.schedule('*/2 * * * *', async () => {
    async function runReminderJob() {
    console.log('REMINDER JOB STARTED');

    try {
}, {
    timezone: 'Europe/Moscow'
});

// ===== START =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        'Нажмите кнопку, чтобы отправить номер',
        {
            reply_markup: {
                keyboard: [
                    [
                        {
                            text: '📱 Отправить номер',
                            request_contact: true
                        }
                    ]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        }
    );
});
// ===== CONTACT =====
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    let phone = msg.contact.phone_number.replace(/[^\d]/g, '');

    try {
        const res = await axios.post(
            `${BITRIX_WEBHOOK}crm.duplicate.findbycomm`,
            {
                type: 'PHONE',
                values: [phone]
            }
        );

        const contactId = res.data.result.CONTACT?.[0];

        if (!contactId) {
            await bot.sendMessage(chatId, 'Клиент не найден');
            return;
        }

        await axios.post(`${BITRIX_WEBHOOK}crm.contact.update`, null, {
            params: {
                id: contactId,
                fields: {
                    [TG_CHAT_FIELD]: String(chatId)
                }
            }
        });

        userData[chatId] = {
            phone,
            contactId,
            archiveDeals: [],
            archiveShown: false,
            archiveMessageIds: []
        };

        const dealsRes = await axios.get(`${BITRIX_WEBHOOK}crm.deal.list`, {
            params: {
                filter: {
                    CONTACT_ID: contactId
                },
                select: ['*', 'UF_*']
            }
        });

        const deals = dealsRes.data.result || [];
        const fields = await getFields();

        let activeDeals = [];
        let archiveDeals = [];

        for (let deal of deals) {
            if (
                deal.STAGE_SEMANTIC_ID !== 'S' &&
                deal.STAGE_SEMANTIC_ID !== 'F'
            ) {
                continue;
            }

            const isActive =
                new Date(deal.UF_CRM_1733304976338) >= new Date();

            if (isActive) {
                activeDeals.push(deal);
            } else {
                archiveDeals.push(deal);
            }
        }

        userData[chatId].archiveDeals = archiveDeals;

        for (let deal of activeDeals) {
            const typeName = getEnum(
                fields.UF_CRM_1733304911569,
                deal.UF_CRM_1733304911569
            );

            const companyName = getEnum(
                fields.UF_CRM_1733304804509,
                deal.UF_CRM_1733304804509
            );

            let text = `📄 Полис — ${getStatus(deal.UF_CRM_1733304976338)}
Вид: ${typeName}
Компания: ${companyName}
Номер: ${deal.UF_CRM_1733304951785 || '-'}
Сумма: ${formatMoney(deal.OPPORTUNITY)} ₽
Начало: ${formatDate(deal.UF_CRM_1775074852567)}
Конец: ${formatDate(deal.UF_CRM_1733304976338)}
`;
            if (isAutoPolicy(typeName)) {
                text += `
🚗 Автомобиль:
${deal.UF_CRM_1733305076124 || '-'}
${deal.UF_CRM_1733305117367 || '-'}
${deal.UF_CRM_1733305134235 || '-'}
`;
            }

            await bot.sendMessage(chatId, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔄 Продлить',
                                callback_data: `renew_${deal.ID}`
                            }
                        ]
                    ]
                }
            });
        }

        if (archiveDeals.length > 0) {
            await bot.sendMessage(
                chatId,
                `У вас есть ${archiveDeals.length} завершённых ${getPolisWord(archiveDeals.length)} 👇`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '📂 Показать архив',
                                    callback_data: 'toggle_archive'
                                }
                            ]
                        ]
                    }
                }
            );
        }

    } catch (e) {
        console.log('CONTACT ERROR:', e.message);
        await bot.sendMessage(chatId, 'Ошибка');
    }
});

// ===== CALLBACK =====
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = userData[chatId];

    if (!user) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    try {
        if (data === 'toggle_archive') {
            if (!user.archiveShown) {
                user.archiveMessageIds = [];

                for (const deal of user.archiveDeals) {
                    const msg = await bot.sendMessage(
                        chatId,
                        `📄 Архивный полис — 🔴 Истёк
Номер: ${deal.UF_CRM_1733304951785 || '-'}
Сумма: ${formatMoney(deal.OPPORTUNITY)} ₽
Конец: ${formatDate(deal.UF_CRM_1733304976338)}`
                    );

                    user.archiveMessageIds.push(msg.message_id);
                }

                user.archiveShown = true;
                await bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: [
                            [
                                {
                                    text: '❌ Скрыть архив',
                                    callback_data: 'toggle_archive'
                                }
                            ]
                        ]
                    },
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );

            } else {
                for (const id of user.archiveMessageIds) {
                    try {
                        await bot.deleteMessage(chatId, id);
                    } catch {}
                }

                user.archiveShown = false;

                await bot.editMessageReplyMarkup(
                    {
                        inline_keyboard: [
                            [
                                {
                                    text: '📂 Показать архив',
                                    callback_data: 'toggle_archive'
                                }
                            ]
                        ]
                    },
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id
                    }
                );
            }
        }

        if (data.startsWith('renew_')) {
            const dealId = data.split('_')[1];
            await sendRenewRequest(chatId, user, dealId);
        }

    } catch (e) {
        console.log('CALLBACK ERROR:', e.message);
    }

    await bot.answerCallbackQuery(query.id);
});

console.log('Bot started');