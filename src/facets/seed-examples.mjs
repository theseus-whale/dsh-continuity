/**
 * Hand-written seed phrases for cold-start facet extraction.
 * These are not labels from history; they are a prior over the fixed schema.
 */
import { SLOTS, VALUES } from './schema.mjs';

export const SEED_EXAMPLES = Object.freeze({
  activity: {
    跑团: ['我们掷骰决定行动，角色在场景里探索。', '跑团开始，我先描述角色要做什么。'],
    开发: ['写代码实现这个插件功能。', '修改模块并打包发布。'],
    调试: ['看报错日志，定位进程和配置问题。', '这个 bug 复现了，先查调用栈。'],
    测试: ['跑测试用例，检查回归。', '新增断言并验证结果。'],
    文档: ['写安装说明和交接文档。', '整理报告，记录结论。'],
    对话: ['我们聊聊这个东西的意义。', '你怎么看这件事？'],
    其他: ['处理一个不属于上述类别的杂项。'],
  },
  interaction: {
    回合制: ['一轮一轮来，等我描述完再继续。', '轮到你了，下一步怎么行动？'],
    指令式: ['执行这个命令，把结果给我。', '按步骤完成操作。'],
    自由对话: ['随便聊聊，不用按流程。', '我们自由讨论一下。'],
    无: ['没有明确的交互形式。'],
  },
  participants: {
    单人: ['我一个人在检查这个文件。', '我自己先想一下。'],
    多人: ['几个人一起讨论方案。', '多人协作完成。'],
    协作: ['我们一起把这件事做完。', '你和我配合处理。'],
    对抗: ['双方对抗，各自争取胜利。', '对手和我对立。'],
    无: ['没有参与者信息。'],
  },
  medium: {
    文字: ['用中文写一段说明。', '这段是纯文本对话。'],
    代码: ['这里是 TypeScript 代码和命令行。', '```js\nconst x = 1\n```'],
    图像: ['![](.png) 看这张图。', '生成一张头像和对照图。'],
    语音: ['听这段语音。', '用 TTS 读出来。'],
    无: ['没有媒介。'],
  },
  topic: {
    剧情: ['故事里的角色走进灯室。', '这一段是剧情推进。'],
    技术: ['插件运行在 Node 上，改 engine 逻辑。', '接口和实现细节。'],
    设备: ['手机、显卡和性能对比。', '这台设备的配置。'],
    记忆: ['记忆宫殿、连续性和身份。', '我们之前聊过的那段记忆。'],
    规则: ['规则要求每轮写 TAG。', '政策和闸的判定。'],
    其他: ['其他话题。'],
  },
});

export function seedRows() {
  const rows = [];
  for (const slot of SLOTS) {
    if (slot === 'random') continue;
    for (const value of VALUES[slot]) {
      for (const text of SEED_EXAMPLES[slot]?.[value] ?? []) {
        rows.push({ text, facets: { [slot]: value } });
      }
    }
  }
  return rows;
}
