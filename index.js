const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.BOT_TOKEN;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(token, { polling: true });

// ===== формат =====
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
    return new Date(endDate) >= new Date() ? '🟢 Активен' : '🔴 Истёк';
}

function getPolisWord(count) {
    if (count % 10 === 1 && count % 100 !== 11) return 'полис';
    if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'полиса';
    return 'полисов';
}

// ===== справочники Bitrix =====
let fieldsCache = null;

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

// ===== память =====
const userData = {};

// ===== старт =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Нажмите кнопку, чтобы отправить номер', {
        reply_markup: {
            keyboard: [[{ text: '📱 Отправить номер', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// ===== контакт =====
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    let phone = msg.contact.phone_number.replace(/[^\d]/g, '');

    try {
        const res = await axios.post(`${BITRIX_WEBHOOK}crm.duplicate.findbycomm`, {
            type: 'PHONE',
            values: [phone]
        });

        const contactId = res.data.result.CONTACT?.[0];

        if (!contactId) {
            await bot.sendMessage(chatId, 'Клиент не найден');
            return;
        }

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
        const deals = dealsRes.data.result;
console.log('ВСЕ СДЕЛКИ:', deals.length);

for (let d of deals) {
    console.log({
        ID: d.ID,
        TITLE: d.TITLE,
        CONTACT_ID: d.CONTACT_ID,
        STAGE_ID: d.STAGE_ID,
        STAGE_SEMANTIC_ID: d.STAGE_SEMANTIC_ID,
        END: d.UF_CRM_1733304976338
    });
}
        const fields = await getFields();

        let activeDeals = [];
        let archiveDeals = [];

     for (let deal of deals) {
    // берём только реально закрытые сделки
    if (deal.STAGE_SEMANTIC_ID !== 'S' && deal.STAGE_SEMANTIC_ID !== 'F') {
        continue;
    }

    const isActive = new Date(deal.UF_CRM_1733304976338) >= new Date();

    if (isActive) {
        activeDeals.push(deal);
    } else {
        archiveDeals.push(deal);
    }
}

        userData[chatId].archiveDeals = archiveDeals;

        // ===== АКТИВНЫЕ =====
        for (let deal of activeDeals) {

            const typeName = getEnum(fields.UF_CRM_1733304911569, deal.UF_CRM_1733304911569);
            const companyName = getEnum(fields.UF_CRM_1733304804509, deal.UF_CRM_1733304804509);

            let text = `📄 Полис — ${getStatus(deal.UF_CRM_1733304976338)}
Вид: ${typeName}
Компания: ${companyName}
Номер: ${deal.UF_CRM_1733304951785 || '-'}
Сумма: ${formatMoney(deal.OPPORTUNITY)} ₽
Начало: ${formatDate(deal.UF_CRM_1775074852567)}
Конец: ${formatDate(deal.UF_CRM_1733304976338)}
`;

            if (typeName === 'ОСАГО' || typeName === 'КАСКО') {
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
                        [{ text: '🔄 Продлить', callback_data: `renew_${deal.ID}` }]
                    ]
                }
            });
        }

        // ===== АРХИВ =====
        if (archiveDeals.length > 0) {
            await bot.sendMessage(
                chatId,
                `У вас есть ${archiveDeals.length} завершённых ${getPolisWord(archiveDeals.length)} 👇`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📂 Показать архив', callback_data: 'toggle_archive' }]
                        ]
                    }
                }
            );
        }

    } catch (e) {
        console.log(e);
        bot.sendMessage(chatId, 'Ошибка');
    }
});

// ===== кнопки =====
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = userData[chatId];

    if (!user) return;

    // ===== архив =====
    if (data === 'toggle_archive') {
        if (!user.archiveShown) {
            user.archiveMessageIds = [];

            for (let deal of user.archiveDeals) {
                const msg = await bot.sendMessage(chatId, `📄 Архивный полис — 🔴 Истёк
Номер: ${deal.UF_CRM_1733304951785}
Сумма: ${formatMoney(deal.OPPORTUNITY)} ₽
Конец: ${formatDate(deal.UF_CRM_1733304976338)}
`);
                user.archiveMessageIds.push(msg.message_id);
            }

            user.archiveShown = true;

            await bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: '❌ Скрыть архив', callback_data: 'toggle_archive' }]
                ]
            }, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

        } else {
            for (let id of user.archiveMessageIds) {
                try {
                    await bot.deleteMessage(chatId, id);
                } catch {}
            }

            user.archiveShown = false;

            await bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: '📂 Показать архив', callback_data: 'toggle_archive' }]
                ]
            }, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
        }
    }

    // ===== ПРОДЛЕНИЕ =====
    if (data.startsWith('renew_')) {
        const dealId = data.split('_')[1];

        const dealRes = await axios.get(`${BITRIX_WEBHOOK}crm.deal.get`, {
            params: { id: dealId }
        });

        const deal = dealRes.data.result;
        const fields = await getFields();

        const typeName = getEnum(fields.UF_CRM_1733304911569, deal.UF_CRM_1733304911569);
        const companyName = getEnum(fields.UF_CRM_1733304804509, deal.UF_CRM_1733304804509);

        const contactRes = await axios.get(`${BITRIX_WEBHOOK}crm.contact.get`, {
            params: { id: user.contactId }
        });

        const contact = contactRes.data.result;
        const clientName = `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim();

        const message = `🔥 ЗАЯВКА НА ПРОДЛЕНИЕ
👤 Клиент: ${clientName}
📞 Телефон: ${user.phone}
📄 Полис: ${deal.UF_CRM_1733304951785}
📌 Вид: ${typeName}
🏢 Компания: ${companyName}
🆔 Сделка: ${dealId}
`;

        await bot.sendMessage(ADMIN_CHAT_ID, message);
        await bot.sendMessage(chatId, '✅ Заявка отправлена! Мы скоро свяжемся с вами');
    }

    bot.answerCallbackQuery(query.id);
});