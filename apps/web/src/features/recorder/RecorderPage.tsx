import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Divider,
  Form,
  Input,
  List,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { AudioOutlined, CloudUploadOutlined, ScissorOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  type AudioAttachmentDto,
  type AudioClipDto,
  type VagueCategory,
} from '@froa/shared';
import { audioApi, recipeApi, vagueItemApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { AudioRecorder, analyzeAudio, type RecordedAudio } from '../../components/AudioRecorder';
import { Waveform, formatMs, type WaveformSelection } from '../../components/Waveform';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { usePlayerStore } from '../../store/player';

const KIND_LABELS = {
  recipe_voice: '长辈口述',
  answer_voice: '回答追问',
  note_voice: '补充备注',
} as const;

/** 追问建议里的话术来源标记：家族模板 / 我的覆盖 / 内置兜底 */
const SOURCE_LABELS = {
  family: '家族话术',
  override: '我的问法',
  builtin: '内置问法',
} as const;

const SOURCE_COLORS = {
  family: 'default',
  override: 'blue',
  builtin: 'default',
} as const;

/**
 * 录音工作台 —— 闭环的入口。
 *
 * 设计目标是"想起什么就立刻录，录完顺手标出哪句说不清"：
 *   录音 -> 上传 -> 框选片段 -> 转写 -> 标出模糊句 -> 生成待澄清条目
 */
export function RecorderPage() {
  const { workspaceId, recipeId } = useParams<{ workspaceId: string; recipeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { playAudio } = useAudioPlayback();

  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const [audio, setAudio] = useState<AudioAttachmentDto | null>(null);
  const [kind, setKind] = useState<keyof typeof KIND_LABELS>('recipe_voice');
  const [selection, setSelection] = useState<WaveformSelection | null>(null);
  const [clip, setClip] = useState<AudioClipDto | null>(null);
  const [transcript, setTranscript] = useState('');
  const [markOpen, setMarkOpen] = useState(false);
  const [markForm] = Form.useForm<{ category: VagueCategory; rawPhrase: string; assigneeId?: string }>();
  const [createdCount, setCreatedCount] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const playLocal = usePlayerStore((s) => s.play);
  // 本地试听用的 blob URL 必须显式释放，否则每次重录都会漏一份内存
  const objectUrlRef = useRef<string | null>(null);

  const revokeObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => revokeObjectUrl, []);

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => recipeApi.get(recipeId!),
    enabled: Boolean(recipeId),
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => workspaceApi.members(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const audioList = useQuery({
    queryKey: ['audio', recipeId],
    queryFn: () => audioApi.list({ recipeId: recipeId! }),
    enabled: Boolean(recipeId),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: RecordedAudio) => {
      const uploaded = await audioApi.upload({
        file: file.blob,
        filename: file.filename,
        recipeId: recipeId!,
        kind,
        durationMs: file.durationMs,
        peaks: file.peaks,
      });
      return audioApi.transcribe(uploaded.id);
    },
    onSuccess: (result) => {
      revokeObjectUrl();
      setAudio(result.audio);
      setTranscript(result.audio.transcript ?? '');
      setRecorded(null);
      if (result.needsManualInput) {
        message.info('音频已保存。当前转写模式是"人工录入"，请在右侧把听到的内容打下来。');
      } else {
        message.success(`已用 ${result.provider} 自动转写，请核对后修改。`);
      }
      void queryClient.invalidateQueries({ queryKey: ['audio', recipeId] });
      void queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveTranscriptMutation = useMutation({
    mutationFn: () => audioApi.updateTranscript(audio!.id, transcript),
    onSuccess: (updated) => {
      setAudio(updated);
      message.success('转写文本已保存');
      void queryClient.invalidateQueries({ queryKey: ['audio', recipeId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const clipMutation = useMutation({
    mutationFn: () => audioApi.createClip(audio!.id, { startMs: selection!.startMs, endMs: selection!.endMs }),
    onSuccess: (created) => {
      setClip(created);
      message.success(`已框选片段 ${formatMs(created.startMs)} – ${formatMs(created.endMs)}`);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const createItemMutation = useMutation({
    mutationFn: (values: { category: VagueCategory; rawPhrase: string; assigneeId?: string }) =>
      vagueItemApi.create(recipeId!, {
        category: values.category,
        rawPhrase: values.rawPhrase,
        transcript: transcript.slice(0, 2000) || null,
        clipId: clip?.id ?? null,
        assigneeId: values.assigneeId ?? null,
      }),
    onSuccess: () => {
      setCreatedCount((count) => count + 1);
      setMarkOpen(false);
      markForm.resetFields();
      message.success('已加入追问台');
      void queryClient.invalidateQueries({ queryKey: ['vague-items'] });
      void queryClient.invalidateQueries({ queryKey: ['recipe', recipeId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const suggestionMutation = useMutation({
    mutationFn: () => vagueItemApi.suggest(recipeId!, transcript),
  });

  if (recipe.isLoading) return <Spin size="large" />;

  const openMarkDialog = (rawPhrase: string, category: VagueCategory) => {
    markForm.setFieldsValue({ rawPhrase, category });
    setMarkOpen(true);
  };

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>录音工作台 · {recipe.data?.title}</h1>
          <div className="froa-hint">
            原始语音会永久保留。整理出来的每一句结论，之后都能点一下回到当时那句话。
          </div>
        </div>
        <Space wrap>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}/inbox`}>
            <Button>去追问台{createdCount ? `（新增 ${createdCount}）` : ''}</Button>
          </Link>
          <Link to={`/w/${workspaceId}/recipes/${recipeId}`}>
            <Button type="primary">查看食谱</Button>
          </Link>
        </Space>
      </div>

      <Space wrap>
        <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)} buttonStyle="solid">
          {Object.entries(KIND_LABELS).map(([value, label]) => (
            <Radio.Button key={value} value={value}>
              {label}
            </Radio.Button>
          ))}
        </Radio.Group>
        <Tag color="blue">单文件请勿超过 100MB</Tag>
      </Space>

      {!audio ? (
        <div className="froa-stack">
          <AudioRecorder
            onRecorded={(result) => {
              revokeObjectUrl();
              setRecorded(result);
              // 还没上传，先用本地 blob 试听，确认录对了再保存
              const url = URL.createObjectURL(result.blob);
              objectUrlRef.current = url;
              playLocal({
                audioId: 'local-preview',
                src: url,
                label: '刚录的这一段（尚未保存）',
              });
            }}
            onDiscard={() => {
              revokeObjectUrl();
              setRecorded(null);
            }}
            hint="如果长辈不方便用手机，你也可以先录下来，之后在这里补录文字。"
          />

          {recorded && (
            <div className="froa-card">
              <h3 className="froa-card-title">刚才录的这段话</h3>
              <Waveform peaks={recorded.peaks} durationMs={recorded.durationMs} onSeek={setPlayhead} />
              <div className="froa-row" style={{ marginTop: '0.75rem' }}>
                <Button
                  type="primary"
                  icon={<CloudUploadOutlined />}
                  loading={uploadMutation.isPending}
                  onClick={() => uploadMutation.mutate(recorded)}
                >
                  保存这段语音
                </Button>
                <Button
                  onClick={() => {
                    revokeObjectUrl();
                    setRecorded(null);
                  }}
                >
                  重录
                </Button>
                <span className="froa-hint">
                  时长 {formatMs(recorded.durationMs)}
                  {recorded.peaks ? '，已生成波形' : '，未生成波形（不影响保存）'}
                </span>
              </div>
            </div>
          )}

          <Divider plain>或者直接上传已有的录音</Divider>

          <Upload
            accept="audio/*"
            showUploadList={false}
            beforeUpload={async (file) => {
              // 上传的音频同样要在前端解出时长与波形，否则框选不出片段
              const analysis = await analyzeAudio(file as File).catch(() => null);
              uploadMutation.mutate({
                blob: file,
                durationMs: analysis?.durationMs ?? 0,
                peaks: analysis?.peaks ?? null,
                filename: (file as File).name,
              });
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploadMutation.isPending}>
              选择音频文件
            </Button>
          </Upload>
        </div>
      ) : (
        <div className="froa-inbox-columns">
          {/* 左：原声 */}
          <div className="froa-card">
            <h3 className="froa-card-title">原始语音</h3>
            <div className="froa-item-meta" style={{ marginBottom: '0.5rem' }}>
              <Tag>{KIND_LABELS[audio.kind as keyof typeof KIND_LABELS] ?? audio.kind}</Tag>
              <span>时长 {formatMs(audio.durationMs)}</span>
              <span>校验和 {audio.sha256.slice(0, 10)}…</span>
            </div>

            <Waveform
              peaks={audio.peaks}
              durationMs={audio.durationMs}
              selection={selection}
              playheadMs={playhead}
              onSelect={setSelection}
              onSeek={setPlayhead}
            />

            <div className="froa-row" style={{ marginTop: '0.75rem' }}>
              <Button
                icon={<AudioOutlined />}
                onClick={() =>
                  playAudio(audio, {
                    startMs: selection?.startMs,
                    endMs: selection?.endMs,
                    label: selection ? '框选的片段' : '原始语音',
                  })
                }
              >
                播放{selection ? '选中片段' : '整段'}
              </Button>

              <Button
                icon={<ScissorOutlined />}
                disabled={!selection}
                loading={clipMutation.isPending}
                onClick={() => clipMutation.mutate()}
              >
                把选中部分设为单独片段
              </Button>

              {clip && (
                <Tag color="green">
                  已框选：{formatMs(clip.startMs)} – {formatMs(clip.endMs)}
                </Tag>
              )}
            </div>

            <Typography.Paragraph type="secondary" style={{ marginTop: '0.75rem' }}>
              在波形上按住拖动即可框选。框选后，新建的待澄清条目会自动带上这段原声，
              以后点"听原声"就能直接跳到这句话。
            </Typography.Paragraph>

            <Divider />

            <h4>已保存的语音</h4>
            <List
              size="small"
              dataSource={audioList.data ?? []}
              locale={{ emptyText: '还没有其它语音' }}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button
                      key="play"
                      type="link"
                      onClick={() =>
                        playAudio(item, { label: KIND_LABELS[item.kind as keyof typeof KIND_LABELS] ?? item.kind })
                      }
                    >
                      播放
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={`${KIND_LABELS[item.kind as keyof typeof KIND_LABELS] ?? item.kind} · ${formatMs(item.durationMs)}`}
                    description={
                      item.transcriptStatus === 'done'
                        ? (item.transcript ?? '').slice(0, 40) || '已转写（内容为空）'
                        : '待转写'
                    }
                  />
                </List.Item>
              )}
            />
          </div>

          {/* 右：转写与标记 */}
          <div className="froa-detail">
            <h3 className="froa-card-title">转写与标注</h3>
            <Typography.Paragraph type="secondary">
              把长辈说的话打在这里（或核对自动转写结果），然后找出"说不清"的地方标出来。
            </Typography.Paragraph>

            <Input.TextArea
              rows={8}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={'例如：\n先炒糖色，放一点糖就行\n中火炒到收汁\n肉炖到用筷子能戳透'}
            />

            <div className="froa-row" style={{ marginTop: '0.75rem' }}>
              <Button type="primary" onClick={() => saveTranscriptMutation.mutate()} loading={saveTranscriptMutation.isPending}>
                保存转写
              </Button>
              <Button
                onClick={() => suggestionMutation.mutate()}
                loading={suggestionMutation.isPending}
                disabled={!transcript.trim()}
              >
                自动找找哪句说不清
              </Button>
            </div>

            {suggestionMutation.data && (
              <>
                <Divider />
                <h4>可能说不清的句子（{suggestionMutation.data.count}）</h4>
                {suggestionMutation.data.count === 0 ? (
                  <Typography.Text type="secondary">
                    没找到明显的模糊表述。也可能这段本来就说得挺清楚。
                  </Typography.Text>
                ) : (
                  <List
                    size="small"
                    dataSource={suggestionMutation.data.matches}
                    renderItem={(match) => (
                      <List.Item
                        actions={[
                          <Button
                            key="mark"
                            type="link"
                            onClick={() => openMarkDialog(match.matchedPattern, match.category)}
                          >
                            这句说不清
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          title={
                            <Space>
                              <span className={`froa-tag-cat cat-${match.category}`}>
                                {VAGUE_CATEGORY_LABELS[match.category]}
                              </span>
                              <span>「{match.matchedPattern}」</span>
                            </Space>
                          }
                          description={
                            <span className="froa-hint">
                              {match.suggestion ? (
                                <>
                                  建议：{match.suggestion}
                                  <br />
                                </>
                              ) : null}
                              可以这样问：{match.question}{' '}
                              <Tag style={{ marginLeft: 4 }} color={SOURCE_COLORS[match.source]}>
                                {SOURCE_LABELS[match.source]}
                              </Tag>
                            </span>
                          }
                        />
                      </List.Item>
                    )}
                  />
                )}
              </>
            )}

            <Divider />

            <Button block onClick={() => openMarkDialog('', 'other')}>
              手动标记一条说不清的
            </Button>
          </div>
        </div>
      )}

      <Modal
        forceRender
        open={markOpen}
        title="这句说不清 —— 加入追问台"
        onCancel={() => setMarkOpen(false)}
        onOk={() => markForm.submit()}
        okText="加入追问台"
        cancelText="取消"
        confirmLoading={createItemMutation.isPending}
      >
        <Form form={markForm} layout="vertical" onFinish={(values) => createItemMutation.mutate(values)}>
          <Form.Item label="这属于哪一类" name="category" rules={[{ required: true, message: '请选择分类' }]}>
            <Select
              options={VAGUE_CATEGORIES.map((category) => ({
                value: category,
                label: VAGUE_CATEGORY_LABELS[category],
              }))}
            />
          </Form.Item>

          <Form.Item
            label="家人的原话"
            name="rawPhrase"
            rules={[{ required: true, message: '请填写原话' }]}
          >
            <Input placeholder="放一点糖" />
          </Form.Item>

          <Form.Item label="这条想先问谁（可选）" name="assigneeId">
            <Select
              allowClear
              placeholder="选择要追问的家人"
              options={(members.data ?? []).map((member) => ({
                value: member.userId,
                label: `${member.displayName}（${member.role}）`,
              }))}
            />
          </Form.Item>

          {clip ? (
            <Typography.Text type="success">
              会关联你刚框选的片段 {formatMs(clip.startMs)} – {formatMs(clip.endMs)}
            </Typography.Text>
          ) : (
            <Typography.Text type="warning">
              这条没有关联原声片段。建议先在上一步框选，之后再补就找不回那句话了。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
