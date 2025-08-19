require('dotenv').config();
const { App } = require('@slack/bolt');

// 処理中のユーザーを記録（重複防止）- これは残す
const processingUsers = new Set();

// エラー処理済みのメッセージを記録（重複エラー防止）- これは残す
const errorHandledMessages = new Set();

// ユーザーごとのconversation_idを保存するMap（メモリ内）
const userConversations = new Map(); // userId -> conversation_id

// カテゴリー履歴を管理するMap
const userCategoryHistory = new Map(); // userId -> [category1, category2, ...]

// 環境変数からSlackトークンを読み込み
const app = new App({
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  token: process.env.SLACK_BOT_TOKEN,
  logLevel: 'debug'
});

// 相談カテゴリの選択肢
const CONSULTATION_CATEGORIES = [
  { text: "SPEEDAについて", value: "SPEEDAについて" },
  { text: "プロジェクト推進方針について", value: "プロジェクト推進方針について" },
  { text: "NPL販売について", value: "NPL販売について" },
  { text: "NP法人プランについて", value: "NP法人プランについて" },
  { text: "ERプランについて", value: "ERプランについて" },
  { text: "その他", value: "その他" }
];

// カテゴリー履歴を取得する関数
function getUserCategoryHistory(userId) {
  const history = userCategoryHistory.get(userId) || [];
  return history.join(" → ") || "初回相談";
}

// カテゴリー履歴を更新する関数
function updateCategoryHistory(userId, newCategory) {
  const history = userCategoryHistory.get(userId) || [];
  
  // 直近3件のカテゴリーを保持（重複除去）
  if (!history.includes(newCategory)) {
    history.push(newCategory);
    if (history.length > 3) {
      history.shift(); // 古いものを削除
    }
    userCategoryHistory.set(userId, history);
  }
  
  console.log(`📝 ${userId} のカテゴリー履歴: ${getUserCategoryHistory(userId)}`);
}

// Block Kit UIを生成する関数
function createConsultationBlocks() {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "どのような内容についてご相談されますか？カテゴリを選択して、相談内容を入力してください。"
      }
    },
    {
      type: "input",
      block_id: "category_select",
      element: {
        type: "static_select",
        action_id: "consultation_category",
        placeholder: {
          type: "plain_text",
          text: "カテゴリを選択してください"
        },
        options: CONSULTATION_CATEGORIES.map(cat => ({
          text: {
            type: "plain_text",
            text: cat.text
          },
          value: cat.value
        }))
      },
      label: {
        type: "plain_text",
        text: "相談カテゴリ"
      }
    },
    {
      type: "input",
      block_id: "consultation_input",
      element: {
        type: "plain_text_input",
        action_id: "consultation_text",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "相談内容を詳しく教えてください..."
        }
      },
      label: {
        type: "plain_text",
        text: "相談内容"
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "相談する"
          },
          style: "primary",
          action_id: "submit_consultation"
        }
      ]
    }
  ];
}

// メッセージイベント: ボット宛の発言はBlock Kit UIを表示
app.message(async ({ message, client, event, say }) => {
  try {
    // ボットのユーザーIDを取得
    const botUserId = await client.auth.test().then(res => res.user_id);
    
    // 編集されたメッセージの場合の処理
    let actualMessage = message;
    if (message.subtype === 'message_changed') {
      actualMessage = message.message;
    }
    
    // bot自身の編集は完全に無視
    if (message.subtype === 'message_changed' && 
        (message.message.user === botUserId || message.message.bot_id)) {
      return;
    }

    const isDirectMessage = actualMessage.channel_type === 'im';
    const isMentioned = actualMessage.text && actualMessage.text.includes(`<@${botUserId}>`);

    // DMかメンション時のみ反応
    if (!isDirectMessage && !isMentioned) return;

    // メンション部分を除去（メンションの場合）
    let userText = actualMessage.text || '';
    if (isMentioned) {
      userText = userText.replace(`<@${botUserId}>`, '').trim();
    }

    // 曖昧な表現のパターンを定義
    const vaguePatterns = [
      '質問', '相談', '教えて', '聞きたい',
      '質問です', '質問があります', '質問したいです',
      '相談です', '相談があります', '相談したいです',
      '分からない', '困ってます', 'ヘルプ',
      'お疲れ様'
    ];

    // 空文字または曖昧な表現の場合のみBlock Kit UIを表示
    if (userText === '' || 
        vaguePatterns.includes(userText.trim())) {
      
      const threadTs = message.subtype === 'message_changed' ? actualMessage.ts : message.ts;
      
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: "相談内容を入力してください",
        blocks: createConsultationBlocks()
      });
      
      return;
    }

    // 具体的な質問の場合は、従来の自動カテゴリ判定で処理
    handleDirectConsultation(userText, message, client);

  } catch (err) {
    console.error("Error in main message handler:", err);
    
    const threadTs = message.subtype === 'message_changed' ? message.message.ts : message.ts;
    
    await client.chat.postMessage({
      channel: message.channel,
      text: "すみません、ただいま回答できません。",
      thread_ts: threadTs
    });
  }
});

// Block Kit UIからの送信ボタンクリック処理
app.action('submit_consultation', async ({ ack, body, client }) => {
  await ack();

  try {
    const values = body.state.values;
    const selectedCategory = values.category_select.consultation_category.selected_option.value;
    const consultationText = values.consultation_input.consultation_text.value;
    
    if (!consultationText || consultationText.trim() === '') {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: "相談内容を入力してください。"
      });
      return;
    }

    console.log(`カテゴリ: ${selectedCategory}, 内容: ${consultationText}`);

    // 初回投稿（"回答中..."のプレースホルダー）
    const initialMessage = await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: "回答を生成中..."
    });

    const userId = body.user.id;
    const messageTs = body.message.ts;
    
    // 重複防止キー生成
    const crypto = require('crypto');
    const contentHash = crypto.createHash('md5').update(consultationText).digest('hex').substring(0, 8);
    const userKey = `${userId}-${messageTs}-${contentHash}`;
    
    // 重複処理を防ぐチェック
    if (processingUsers.has(userKey)) {
      console.log(`重複処理をスキップ: ${userKey}`);
      return;
    }
    
    processingUsers.add(userKey);
    
    // ユーザーの既存conversation_idを取得（なければ空文字）
    let conversationId = userConversations.get(userId) || "";
    console.log(`📱 ユーザー ${userId} の既存conversation_id: "${conversationId}"`);

    // バックグラウンドで非同期処理を実行
    processConsultationInBackground(
      userKey, 
      consultationText, 
      selectedCategory,
      conversationId, 
      userId, 
      body.channel.id,
      client, 
      initialMessage.ts
    );

  } catch (error) {
    console.error("Error handling consultation submission:", error);
    
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "エラーが発生しました。もう一度お試しください。"
    });
  }
});

// 直接的な質問の場合の処理（従来のロジック）
async function handleDirectConsultation(userText, message, client) {
  const userId = message.user;
  const messageTs = message.ts;
  
  // より確実な重複防止キー生成
  const crypto = require('crypto');
  const contentHash = crypto.createHash('md5').update(userText).digest('hex').substring(0, 8);
  const userKey = `${userId}-${messageTs}-${contentHash}`;
  
  // 重複処理を防ぐチェック
  if (processingUsers.has(userKey)) {
    console.log(`重複処理をスキップ: ${userKey}`);
    return;
  }
  
  processingUsers.add(userKey);
  
  // ユーザーの既存conversation_idを取得（なければ空文字）
  let conversationId = userConversations.get(userId) || "";
  console.log(`📱 ユーザー ${userId} の既存conversation_id: "${conversationId}"`);

  // 初回投稿（"回答中..."のプレースホルダー）
  const threadTs = message.subtype === 'message_changed' ? message.message.ts : message.ts;
  const initialMessage = await client.chat.postMessage({
    channel: message.channel,
    text: "回答を生成中...",
    thread_ts: threadTs
  });
  
  // 相談カテゴリを自動判定
  const consultationCategory = determineConsultationCategory(userText);
  
  // バックグラウンドで非同期処理を実行
  processConsultationInBackground(
    userKey,
    userText,
    consultationCategory,
    conversationId,
    userId,
    message.channel,
    client,
    initialMessage.ts
  );
}

// 相談カテゴリを判定する関数（従来のロジック）
function determineConsultationCategory(userText) {
  const text = userText.toLowerCase();
  
  if (text.includes('speeda') || text.includes('スピーダ') || text.includes('有償トライアルプラン') || text.includes('特約') || text.includes('関連')) {
    return 'SPEEDAについて';
  }
  
  if (text.includes('推進') || text.includes('進め方') || text.includes('方針') || text.includes('戦略')) {
    return 'プロジェクト推進方針について';
  }
  
  if (text.includes('NPL') || text.includes('販売') || text.includes('LEND') || text.includes('規約')) {
    return 'NPL販売について';
  }
  
  if (text.includes('NP法人プラン') || text.includes('管理') || text.includes('スピーダSF') || text.includes('商談')) {
    return 'NP法人プランについて';
  }
  
  if (text.includes('ERプラン') || text.includes('新設') || text.includes('戦略')) {
    return 'ERプランについて';
  }
  
  return 'その他';
}

// バックグラウンド処理を分離した関数
async function processConsultationInBackground(userKey, userText, consultationCategory, conversationId, userId, channelId, client, initialMessageTs) {
  try {
    // 処理開始前に再度重複チェック
    if (!processingUsers.has(userKey)) {
      console.log(`処理がキャンセルされました（バックグラウンド開始時）: ${userKey}`);
      return;
    }

    // カテゴリー履歴を更新
    updateCategoryHistory(userId, consultationCategory);

    // 処理開始ログ（詳細版）
    console.log(`🔍 会話開始 - ユーザー: ${userId}`);
    console.log(`📂 現在のカテゴリー: ${consultationCategory}`);
    console.log(`💬 conversation_id: "${conversationId}"`);
    console.log(`📚 カテゴリー履歴: ${getUserCategoryHistory(userId)}`);

    // Dify APIへリクエスト送信（拡張版）
    const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DIFY_API_KEY}`
      },
      body: JSON.stringify({
        inputs: {
          consultation_category: consultationCategory,
          category_history: getUserCategoryHistory(userId),
          is_continuation: conversationId !== "",
          user_context: `ユーザー${userId}の${conversationId ? '継続' : '新規'}相談`
        },
        query: userText,
        response_mode: "streaming",
        conversation_id: conversationId,
        user: userId
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // ストリーミングレスポンスの処理
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let fullAnswer = '';
    let updateCounter = 0;
    let lastUpdateTime = Date.now();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6);
              if (jsonStr.trim() === '' || jsonStr.trim() === '[DONE]') continue;
              
              const data = JSON.parse(jsonStr);

              // conversation_idを保存（初回または更新時）
              if (data.conversation_id) {
                userConversations.set(userId, data.conversation_id);
                console.log(`💾 conversation_id保存: ${userId} -> ${data.conversation_id}`);
              }

              // イベントタイプに応じた処理
              if (data.event === 'message' || data.event === 'agent_message') {
                if (data.answer) {
                  fullAnswer += data.answer;
                  updateCounter++;
                  
                  const currentTime = Date.now();
                  
                  // 更新頻度を制限（1秒間隔または文の終わりで）
                  if (currentTime - lastUpdateTime > 1000 || 
                      data.answer.includes('。') || 
                      data.answer.includes('！') || 
                      data.answer.includes('？') ||
                      data.answer.includes('\n')) {
                    
                    lastUpdateTime = currentTime;
                    
                    // Markdown記法を除去して更新
                    const cleanAnswer = removeMarkdownMarkup(fullAnswer);
                    
                    await client.chat.update({
                      channel: channelId,
                      ts: initialMessageTs,
                      text: cleanAnswer || "回答を生成中..."
                    });
                  }
                }
              } else if (data.event === 'message_end') {
                console.log('Message end event received');
              }
              
              // レスポンスが空の場合の処理
              if (!data.event && data.answer && !fullAnswer) {
                fullAnswer = data.answer;
                const cleanAnswer = removeMarkdownMarkup(fullAnswer);
                await client.chat.update({
                  channel: channelId,
                  ts: initialMessageTs,
                  text: cleanAnswer
                });
              }
              
            } catch (parseError) {
              console.log('JSON parse error (normal for streaming):', parseError.message);
              continue;
            }
          }
        }
      }
      
      // 最終的な回答で更新（Markdown記法を除去）
      const cleanFinalAnswer = removeMarkdownMarkup(fullAnswer);
      const finalText = cleanFinalAnswer.trim() || "（エラーにより回答できません）";
      await client.chat.update({
        channel: channelId,
        ts: initialMessageTs,
        text: finalText
      });
      
      // 完了ログ（詳細版）
      console.log(`✅ 会話完了 - ユーザー: ${userId}`);
      console.log(`📊 回答長: ${fullAnswer.length}文字`);
      console.log(`💬 最終conversation_id: ${userConversations.get(userId)}`);
      console.log(`📋 保存済み会話数: ${userConversations.size}人`);

    } catch (streamError) {
      console.error("Streaming error:", streamError);
      throw streamError;
    }

  } catch (error) {
    console.error("Background processing error:", error);
    
    // エラー処理済みマークを設定（重複防止）
    if (!errorHandledMessages.has(userKey)) {
      errorHandledMessages.add(userKey);
      
      await client.chat.update({
        channel: channelId,
        ts: initialMessageTs,
        text: "すみません、ただいま回答できません。"
      });
    }
  } finally {
    // 処理完了後のクリーンアップ
    processingUsers.delete(userKey);
    
    // エラー管理は一定時間後に自動削除（メモリリーク防止）
    setTimeout(() => {
      errorHandledMessages.delete(userKey);
    }, 30000); // 30秒後に削除
  }
}

// Markdownの記法を除去する関数
function removeMarkdownMarkup(text) {
  if (!text) return text;
  
  return text
    // 太字記法を除去
    .replace(/\*\*(.*?)\*\*/g, '$1')  // **text** -> text
    .replace(/\*(.*?)\*/g, '$1')      // *text* -> text
    // 見出し記法を除去
    .replace(/^#{1,6}\s*/gm, '')      // # ## ### etc. -> (空文字)
    // リスト記法を除去
    .replace(/^\s*\*\s+/gm, '')       // * item -> item
    .replace(/^\s*-\s+/gm, '')        // - item -> item
    .replace(/^\s*\+\s+/gm, '')       // + item -> item
    // 番号付きリストを除去
    .replace(/^\s*\d+\.\s+/gm, '')    // 1. item -> item
    // 複数の改行を整理
    .replace(/\n{3,}/g, '\n\n')       // 3個以上の改行を2個に
    .trim();
}

// デバッグ用：現在保存されているconversation_idを表示
function showUserConversations() {
  console.log('📋 現在保存されているユーザー会話:');
  for (const [userId, conversationId] of userConversations.entries()) {
    console.log(`  ${userId}: ${conversationId}`);
  }
}

// デバッグ用：現在保存されているカテゴリー履歴を表示
function showUserCategories() {
  console.log('📂 現在保存されているカテゴリー履歴:');
  for (const [userId, categories] of userCategoryHistory.entries()) {
    console.log(`  ${userId}: ${categories.join(' → ')}`);
  }
}

// アプリを起動
(async () => {
  await app.start();
  console.log('⚡️ Bot app is running!');
  console.log('📚 カテゴリー履歴管理機能が有効です');
  console.log('💬 conversation_id継続機能が有効です');
})();
