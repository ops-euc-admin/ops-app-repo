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

// ユーザーの入力内容を一時保存するMap
const userInputHistory = new Map(); // userId -> { category, text }

// 「続きを読む」の続きを保存する場所を追加
const pendingContinuations = new Map(); // messageTs -> [残りのメッセージ配列]

// 環境変数からSlackトークンを読み込み
const app = new App({
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  token: process.env.SLACK_BOT_TOKEN,
  logLevel: 'debug'
});

// 相談カテゴリの選択肢
const CONSULTATION_CATEGORIES = [
  { text: "承認者", value: "承認者" },
  { text: "申請者", value: "申請者" },
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

// ユーザーの入力内容を保存する関数
function saveUserInput(userId, category, text) {
  userInputHistory.set(userId, { category, text });
  console.log(`💾 ${userId} の入力内容を保存: ${category} - ${text.substring(0, 50)}...`);
}

// Slack mrkdwn対応のメッセージ投稿関数
async function postSlackMessage(client, channel, text, options = {}) {
  return await client.chat.postMessage({
    channel,
    text,
    mrkdwn: true,
    ...options
  });
}

// Block Kit UIを生成する関数（前回の入力内容を反映）
function createConsultationBlocks(userId = null) {
  const savedInput = userId ? userInputHistory.get(userId) : null;
  
  const blocks = [];

  // 1. 前回の内容がある場合は、最初に追加
  if (savedInput) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `💡 *前回の入力内容*\n*カテゴリ:* ${savedInput.category}\n*質問:* ${savedInput.text.substring(0, 100)}${savedInput.text.length > 100 ? '...' : ''}`
      }
    });
  }

  // 2. カテゴリー選択を追加
  const categoryBlock = {
    type: "input",
    block_id: "category_select",
    element: {
      type: "static_select",
      action_id: "role",
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
      text: "質問カテゴリ"
    }
  };

  // 前回のカテゴリーがあれば初期値を設定
  if (savedInput?.category) {
    categoryBlock.element.initial_option = {
      text: {
        type: "plain_text",
        text: savedInput.category
      },
      value: savedInput.category
    };
  }

  blocks.push(categoryBlock);

  // 3. 質問入力を追加
  const questionBlock = {
    type: "input",
    block_id: "consultation_input",
    element: {
      type: "plain_text_input",
      action_id: "consultation_text",
      multiline: true,
      placeholder: {
        type: "plain_text",
        text: "質問内容を詳しく教えてください..."
      }
    },
    label: {
      type: "plain_text",
      text: "質問内容"
    }
  };

  // 前回の質問があれば初期値を設定
  if (savedInput?.text) {
    questionBlock.element.initial_value = savedInput.text;
  }

  blocks.push(questionBlock);

  // 4. ボタンを追加
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "質問する"
        },
        style: "primary",
        action_id: "submit_consultation"
      }
    ]
  });

  return blocks;
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

    const isMentioned = actualMessage.text && actualMessage.text.includes(`<@${botUserId}>`);

    // メンション時のみ反応
    if (!isMentioned) return;

    // メンション部分を除去（メンションの場合）
    let userText = actualMessage.text || '';
    if (isMentioned) {
      userText = userText.replace(`<@${botUserId}>`, '').trim();
    }

    const userId = actualMessage.user;


    // 空文字または曖昧な表現の場合のみBlock Kit UIを表示
    if (userText === '' || 
        vaguePatterns.includes(userText.trim())) {
    
    // メンション時のみUIを表示
    if (isMentioned) {
        const threadTs = message.subtype === 'message_changed' ? actualMessage.ts : message.ts;
        
        await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: "質問内容を入力してください",
        blocks: createConsultationBlocks(userId) // ユーザーIDを渡して前回の入力内容を反映
        });
    }
    // DMの場合は何も表示せずに終了
    return;
    }


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
    const categoryState = values.category_select.role;
    const consultationText = values.consultation_input.consultation_text.value;
    const selectedCategory = categoryState.selected_option?.value || categoryState.initial_option?.value;   

    if (!consultationText || consultationText.trim() === '') {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: "質問内容を入力してください。"
      });
      return;
    }

    const userId = body.user.id;
    
    // 入力内容を保存（次回使用のため）
    saveUserInput(userId, selectedCategory, consultationText);

    console.log(`カテゴリ: ${selectedCategory}, 内容: ${consultationText}`);

    // 確認メッセージを表示（ボタンなし）
    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📝 *受け付けました*\n*カテゴリ:* ${selectedCategory}\n*質問内容:* ${consultationText}`
          }
        },

      ],
      mrkdwn: true
    });

    // 実際の回答生成のための初回投稿（動画リアクション付き）
    const initialMessage = await postSlackMessage(client, body.channel.id, ":arrows_counterclockwise: 回答を生成中...", {
      thread_ts: body.message.ts
    });

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


// 編集ボタンのクリック処理
app.action('edit_consultation', async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    
    // 前回の入力内容を含むUIを再表示
    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: "質問内容を編集してください",
      blocks: createConsultationBlocks(userId)
    });

  } catch (error) {
    console.error("Error handling edit request:", error);
  }
});

app.action('show_inquiry_options', async ({ ack, body, client }) => {
  await ack();

  try {
    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: "問い合わせ先を選択してください",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*問い合わせ先を選択してください*"
          }
        },
        {
          type: "divider"
        },
        // 1行目: 3つのボタン
        {
          type: "actions",
          elements: [
            {
              type: "workflow_button",
              text: {
                type: "plain_text",
                text: "Coupaの利用に関する問い合わせ",
                emoji: true
              },
              workflow: {
                trigger: {
                  url: "https://slack.com/shortcuts/Ft075BJY3BGE/7c8d7b34e92f31947a2f50048fbc2a51"
                }
              }
            },
            {
              type: "workflow_button",
              text: {
                type: "plain_text",
                text: "Coupaのシステム関連の問い合わせ",
                emoji: true
              },
              workflow: {
                trigger: {
                  url: "https://slack.com/shortcuts/Ft075L08SM50/e1bcd58846384a210fa9544c6519fc28"
                }
              }
            },
            {
              type: "workflow_button",
              text: {
                type: "plain_text",
                text: "Coupa契約関連の問い合わせ",
                emoji: true
              },
              workflow: {
                trigger: {
                  url: "https://slack.com/shortcuts/Ft083V9ZS7G8/7397a03f3eb4d75f623825569b21ec4c"
                }
              }
            }
          ]
        },
        // 2行目: 2つのボタン
        {
          type: "actions",
          elements: [
            {
              type: "workflow_button",
              text: {
                type: "plain_text",
                text: "予算枠申請（ServiceNow）関連の問い合わせ",
                emoji: true
              },
              workflow: {
                trigger: {
                  url: "https://slack.com/shortcuts/Ft08MQ8DMCBB/0bcb102b34ae5aee0363541ba614e5b1"
                }
              }
            },
            {
              type: "workflow_button",
              text: {
                type: "plain_text",
                text: "下請法対象取引の発注変更依頼",
                emoji: true
              },
              workflow: {
                trigger: {
                  url: "https://slack.com/shortcuts/Ft094Z2JRUBC/30e4960eb2283c50d1d19647511a54ae"
                }
              },
            }
          ]
        }
      ]
    });

  } catch (error) {
    console.error("Error showing inquiry options:", error);
  }
});

// 「続きを読む」ボタンがクリックされた時の処理
app.action('show_more_continuation', async ({ ack, body, client, action }) => {
  await ack();

  const messageTs = action.value;

  try {
    const remainingParts = pendingContinuations.get(messageTs);

    if (!remainingParts || remainingParts.length === 0) {
      // 既に全て表示済みならボタンを消す
      const originalBlocks = body.message.blocks.filter(b => b.type !== 'actions');
      await client.chat.update({
        channel: body.channel.id,
        ts: messageTs,
        text: body.message.text,
        blocks: originalBlocks,
      });
      pendingContinuations.delete(messageTs);
      return;
    }

    // 次のパートを投稿
    const nextPart = remainingParts.shift();
    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: messageTs,
      text: nextPart,
    });

    const originalBlocks = body.message.blocks.filter(b => b.type !== 'actions');

    if (remainingParts.length > 0) {
      // まだ続きがある場合：ボタンのテキストを更新
      pendingContinuations.set(messageTs, remainingParts);
      originalBlocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: {
            type: 'plain_text',
            text: `▼ 続きを読む (${remainingParts.length}件)`,
          },
          action_id: 'show_more_continuation',
          value: messageTs,
        }],
      });
      await client.chat.update({
        channel: body.channel.id,
        ts: messageTs,
        text: body.message.text,
        blocks: originalBlocks,
      });
    } else {
      // これが最後のパートだった場合：ボタンを削除
      pendingContinuations.delete(messageTs);
      await client.chat.update({
        channel: body.channel.id,
        ts: messageTs,
        text: body.message.text,
        blocks: originalBlocks,
      });
    }
  } catch (error) {
    console.error('show_more_continuation action error:', error);
  }
});




// メッセージを分割して自動送信する関数 (詳細エラーハンドリング付き)
async function sendLongMessage(client, channelId, messageTs, text, userId = null) {
  const maxLength = 1200;

  if (!text || text.trim() === '') {
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: "（エラー: 回答が生成されませんでした）"
      });
    } catch (e) {
      console.error("Failed to update message with empty answer error:", e);
    }
    return;
  }

  const cleanText = convertMarkdownToSlack(text);
  console.log(`📏 処理対象メッセージ: ${cleanText.length}文字, 制限: ${maxLength}文字`);

  // 短い場合はそのまま表示してUIボタンも追加
  if (cleanText.length <= maxLength) {
    try {
      console.log('📤 短いメッセージとして直接更新を試行...');
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: cleanText
      });
      console.log('✅ 短いメッセージの更新完了');
      
      // 短いメッセージの場合もUIボタンを投稿
      if (userId) {
        console.log('🔘 UIボタンを追加中...');
        await addUIButtons(client, channelId, messageTs, userId);
        console.log('✅ UIボタン追加完了');
      }
    } catch (e) {
      console.error("❌ 短いメッセージの更新でエラー:", {
        error: e.message,
        code: e.code,
        response: e.data,
        stack: e.stack,
        channelId,
        messageTs,
        textLength: cleanText.length
      });
    }
    return;
  }

  console.log(`📏 メッセージが長すぎるため自動分割します: ${cleanText.length}文字`);
  
  // メッセージを分割
  const parts = [];
  let textToSplit = cleanText;

  while (textToSplit.length > 0) {
    const part = textToSplit.substring(0, maxLength);
    parts.push(part);
    textToSplit = textToSplit.substring(maxLength);
    console.log(`📊 分割パート作成: ${part.length}文字 (残り: ${textToSplit.length}文字)`);
  }

  console.log(`📋 分割完了: ${parts.length}個のパートに分割`);

  try {
    // 最初の部分で元メッセージを更新
    const firstPart = parts[0];
    console.log(`📤 最初のパート更新を試行... (${firstPart.length}文字)`);
    
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: firstPart
    });

    console.log(`✅ 最初の部分を表示完了 (1/${parts.length})`);

    // 残りの部分を順次投稿（自動）
    for (let i = 1; i < parts.length; i++) {
      try {
        console.log(`📤 パート${i + 1}/${parts.length}を投稿中... (${parts[i].length}文字)`);
        
        // 少し間隔を空けて投稿
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const result = await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: parts[i]
        });
        
        console.log(`✅ パート${i + 1}/${parts.length}を投稿完了`, {
          messageTs: result.ts,
          channel: result.channel
        });
        
      } catch (partError) {
        console.error(`❌ パート${i + 1}の投稿でエラー:`, {
          error: partError.message,
          code: partError.code,
          response: partError.data,
          stack: partError.stack,
          partIndex: i + 1,
          totalParts: parts.length,
          partLength: parts[i].length,
          channelId,
          threadTs: messageTs
        });
        
        // 個別パートでエラーが発生した場合、エラーメッセージを投稿
        try {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: messageTs,
            text: `⚠️ パート${i + 1}の表示でエラーが発生しました。\nエラー詳細: ${partError.message || 'Unknown error'}`
          });
        } catch (errorMsgError) {
          console.error(`❌ エラーメッセージの投稿も失敗:`, {
            error: errorMsgError.message,
            code: errorMsgError.code,
            response: errorMsgError.data
          });
        }
        
        // エラーが発生した場合、処理を継続するか中断するかを決定
        if (partError.code === 'rate_limited') {
          console.log('⏰ レート制限のため3秒待機...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // リトライ
          try {
            console.log(`🔄 パート${i + 1}をリトライ中...`);
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: messageTs,
              text: parts[i]
            });
            console.log(`✅ パート${i + 1}のリトライ成功`);
          } catch (retryError) {
            console.error(`❌ リトライも失敗:`, retryError);
            break; // リトライも失敗した場合は中断
          }
        } else {
          // レート制限以外のエラーの場合は中断
          console.log(`🛑 重大なエラーのため残りのパート投稿を中断`);
          break;
        }
      }
    }

    console.log('✅ 全ての分割メッセージの投稿処理完了');

    // UIボタンを最下部に投稿
    if (userId) {
      try {
        console.log('🔘 最終UIボタンを追加中...');
        await new Promise(resolve => setTimeout(resolve, 500));
        await addUIButtons(client, channelId, messageTs, userId);
        console.log('✅ 最終UIボタン追加完了');
      } catch (buttonError) {
        console.error('❌ UIボタン追加でエラー:', {
          error: buttonError.message,
          code: buttonError.code,
          response: buttonError.data
        });
      }
    }

  } catch (error) {
    const errorDetails = {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack,
      response: error.data,
      channelId,
      messageTs,
      originalTextLength: text.length,
      cleanTextLength: cleanText.length,
      partsCount: parts.length,
      maxLength,
      timestamp: new Date().toISOString()
    };

    console.error("❌ メッセージの自動分割送信中にメジャーエラーが発生:", errorDetails);
    
    // より詳細なエラーメッセージを投稿
    let errorMessage = "エラー: 回答の表示中に問題が発生しました。\n";
        
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: errorMessage
      });
    } catch (finalError) {
      console.error("❌ 最終エラーメッセージの投稿も失敗:", {
        error: finalError.message,
        code: finalError.code,
        response: finalError.data
      });
    }
  }
}



// バックグラウンド処理を分離した関数（改良版）
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
    
    const requestPayload = {
      inputs: {
        role: consultationCategory,
        category_history: getUserCategoryHistory(userId),
        is_continuation: conversationId !== "",
        user_context: `ユーザー${userId}の${conversationId ? '継続' : '新規'}相談`
      },
      query: userText,
      response_mode: "streaming",
      conversation_id: conversationId,
      user: userId
      };

    // 送信する内容をコンソールに出力して正確に確認する
    console.log("🔍 Dify API Request Payload:", JSON.stringify(requestPayload, null, 2));

    // Dify APIへリクエスト送信（拡張版）
    const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DIFY_API_KEY}`
      },
      body: JSON.stringify(requestPayload)
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
    const maxDisplayLength = 2500; // リアルタイム表示用の制限

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
              if (data.conversation_id && userConversations.get(userId) !== data.conversation_id) {
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

                    // リアルタイム表示は制限された長さで
                    let displayText;
                    if (fullAnswer.length > maxDisplayLength) {
                      displayText = convertMarkdownToSlack(fullAnswer.substring(0, maxDisplayLength)) + '\n\n（回答を生成中...）';
                    } else {
                      displayText = convertMarkdownToSlack(fullAnswer) || "回答を生成中...";
                    }

                    try {
                      // ここで displayText の長さを制限
                      displayText = displayText.substring(0, maxDisplayLength);

                      await client.chat.update({
                        channel: channelId,
                        ts: initialMessageTs,
                        text: displayText
                      });
                    } catch (updateError) {
                      // リアルタイム更新でエラーが発生しても処理を継続
                      console.log(`リアルタイム更新エラー: ${updateError.message}`);
                    }
                  }
                }
              } else if (data.event === 'message_end') {
                console.log('Message end event received');
              }

              // レスポンスが空の場合の処理
              if (!data.event && data.answer && !fullAnswer) {
                fullAnswer = data.answer;
              }

            } catch (parseError) {
              console.log('JSON parse error (normal for streaming):', parseError.message);
              continue;
            }
          }
        }
      }

      console.log(`📏 最終回答の長さ: ${fullAnswer.length}文字`);

      // 最終的な回答を長さに応じて送信
      if (fullAnswer.trim()) {
        await sendLongMessage(client, channelId, initialMessageTs, fullAnswer);
      } else {
        await client.chat.update({
          channel: channelId,
          ts: initialMessageTs,
          text: "（エラーにより回答できません）"
        });
      }

      // 回答生成完了後に、ボタン付きのメッセージを別途投稿（エラーハンドリング付き）
      try {
        // ボタンのvalueも長さ制限を考慮
        const buttonValue = `${consultationCategory}|${userText.length > 1000 ? userText.substring(0, 1000) + '...' : userText}`;

        await client.chat.postMessage({
          channel: channelId,
          thread_ts: initialMessageTs, // 同じスレッド内に投稿
          blocks: [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "▶ 問い合わせる"
                  },
                  action_id: "show_inquiry_options",  // ← 新しいアクション
                  style: "primary",
                },
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "✏️ 内容を編集して再質問"
                  },
                  action_id: "edit_consultation"
                }
              ]
            }
          ]
        });
      } catch (buttonError) {
        console.error("Error posting action buttons:", buttonError);
        // ボタンの投稿に失敗しても、メイン処理は成功として扱う
      }

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



// より高機能な変換関数（Block Kit使用時）
function markdownToSlackBlocks(text) {
  if (!text) return [];
  
  const blocks = [];
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    if (section.trim() === '') continue;
    
    // コードブロックの場合
    if (section.match(/```/)) {
      const codeMatch = section.match(/```[\w]*\n?([\s\S]*?)```/);
      if (codeMatch) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`\`\`\n${codeMatch[1]}\n\`\`\``
          }
        });
        continue;
      }
    }
    
    // 通常のテキストセクション
    const cleanText = convertMarkdownToSlack(section);
    if (cleanText.length > 3000) {
      // 長いテキストは分割
      const chunks = cleanText.match(/.{1,3000}(\s|$)/g) || [cleanText];
      chunks.forEach(chunk => {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunk.trim()
          }
        });
      });
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: cleanText
        }
      });
    }
  }
  
  return blocks;
}

// 特定のMarkdown要素をSlack記法に変換する個別関数
function convertMarkdownToSlack(text) {
  if (!text) return text;
  
  try {
    // 段階的に変換
    let result = text;
    
    // 1. コードブロック（最初に処理）
    result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, '```\n$2```');
    
    // 2. 太字・斜体
    result = result.replace(/\*\*(.*?)\*\*/g, '*$1*');
    result = result.replace(/\b_([^_]+)_\b/g, '_$1_');
    
    // 3. 見出し
    result = result.replace(/^# (.+)$/gm, '*🔹 $1*');
    result = result.replace(/^## (.+)$/gm, '*▪️ $1*');
    result = result.replace(/^### (.+)$/gm, '*• $1*');
    result = result.replace(/^#{4,6} (.+)$/gm, '*$1*');
    
    // 4. リスト
    result = result.replace(/^\s*[\*\-\+] (.+)$/gm, '• $1');
    
    // 5. リンク
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
    
    // 6. クリーンアップ
    result = result.replace(/\n{3,}/g, '\n\n').trim();
    
    return result || text; // 変換に失敗した場合は元のテキストを返す
  } catch (error) {
    console.error('convertMarkdownToSlack error:', error);
    return text; // エラーの場合は元のテキストをそのまま返す
  }
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

// デバッグ用：現在保存されている入力履歴を表示
function showUserInputHistory() {
  console.log('💾 現在保存されている入力履歴:');
  for (const [userId, input] of userInputHistory.entries()) {
    console.log(`  ${userId}: ${input.category} - ${input.text.substring(0, 50)}...`);
  }
}

// アプリを起動
(async () => {
  await app.start();
  console.log('⚡️ Bot app is running!');
  console.log('📚 カテゴリー履歴管理機能が有効です');
  console.log('💬 conversation_id継続機能が有効です');
  console.log('💾 入力内容保持機能が有効です');
})();
